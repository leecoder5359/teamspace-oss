import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { parseLessonMode, parseLessonStack } from "@/lib/lessonInject";
import { normalizeTerms } from "@/lib/lessonPromptMatch";
import { clampLessonLimit, normalizeLessonQ, lessonTitleWhere } from "@/lib/lessonQuery";
import {
  personalLessonWhere,
  withLessonMeta,
  parseLessonListScope,
  lessonScopeWhere,
  teammateLessonWhere,
  PERSONAL_NEEDS_PERSON,
  PERSONAL_SCOPE_CONFLICT,
} from "@/lib/lessonAccess";
import { activeMembers, attachTeammateMeta, attachCopiedFrom, type MemberLite } from "@/lib/lessonTeammates";
import { withIdempotency } from "@/lib/idempotency";
import { viewerPersonId } from "@/lib/viewerPerson";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { gzipJson } from "@/lib/gzipJson";

const LessonBody = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(),
  stack: z.string().nullable().optional(),
  /** true = 개인 레슨(userId = 요청한 사람 — 에이전트 토큰이면 발급자) */
  personal: z.boolean().optional(),
  /** required | default | ondemand (생략 = default) */
  mode: z.string().optional(),
  /** 프롬프트 매칭 키워드 — "a,b" 또는 ["a","b"] (UserPromptSubmit 훅이 메시지에 이 단어가 있으면 이 레슨을 넣는다) */
  keywords: z.union([z.array(z.string()), z.string()]).nullable().optional(),
});

export const runtime = "nodejs";

// GET /api/lessons[?projectId=&q=&limit=&mode=&scope=] → 팀 레슨/작업규칙 목록 (전역 + 프로젝트 + 스택 + 내 개인)
// q = 제목 부분일치(대소문자 무시), limit = 1..300(생략하면 전체 — 자사 UI 호환), mode = required|default|ondemand 로 거르기.
// 개인 레슨은 본인(에이전트 토큰이면 발급자) 것만 — admin 은 관리용으로 모두 본다.
// scope(2026-10-18, 생략 = 위 종전 동작): team = 개인 제외 · mine = 내 개인만(admin 도) ·
//   teammates = 활성 팀원의 공개 개인 레슨(editor 이상, admin 도 공개된 것만, 가져온 복사본 제외).
//   teammates 행에는 author{id,name}·copiedId(내가 가져온 복사본), mine 행에는 copiedFrom{id,authorName,deleted}.
// 응답 { lessons, total } — 각 레슨에 scope(personal|project|stack|global)·personal·mode. total 은 limit 앞의 건수.
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const sc = parseLessonListScope(sp.get("scope"));
  if (!sc.ok) return NextResponse.json({ error: sc.error }, { status: 400 });
  const guard = await requireCtx(sc.scope === "teammates" ? "editor" : "viewer");
  if ("err" in guard) return guard.err;
  const projectId = sp.get("projectId");
  const q = normalizeLessonQ(sp.get("q"));
  const limit = clampLessonLimit(sp.get("limit"));
  const modeRaw = sp.get("mode");
  const mode = modeRaw ? parseLessonMode(modeRaw) : null;
  if (mode && !mode.ok) return NextResponse.json({ error: mode.error }, { status: 400 });
  const viewer = { personId: viewerPersonId(guard), role: guard.role };
  const and: object[] = [];
  let members: MemberLite[] = [];
  if (sc.scope === "teammates") {
    members = await activeMembers(guard.workspaceId);
    const tw = teammateLessonWhere(viewer, members.map((x) => x.userId));
    if (!tw) return NextResponse.json({ lessons: [], total: 0 });
    and.push(tw);
  } else {
    const personal = personalLessonWhere(viewer);
    if (personal) and.push(personal);
    const sw = lessonScopeWhere(sc.scope, viewer);
    if (sw) and.push(sw);
  }
  const where = {
    workspaceId: guard.workspaceId,
    ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}),
    ...(and.length ? { AND: and } : {}),
    ...(mode?.ok ? { mode: mode.mode } : {}),
    ...lessonTitleWhere(q),
  };
  const [lessons, total] = await Promise.all([
    prisma.lesson.findMany({
      where,
      orderBy: [{ projectId: "asc" }, { updatedAt: "desc" }],
      ...(limit ? { take: limit } : {}),
    }),
    prisma.lesson.count({ where }),
  ]);
  const meta = lessons.map(withLessonMeta);
  if (sc.scope === "teammates") {
    return gzipJson(req, { lessons: await attachTeammateMeta(guard.workspaceId, viewer.personId as string, meta, members), total });
  }
  if (sc.scope === "mine") return gzipJson(req, { lessons: await attachCopiedFrom(guard.workspaceId, meta), total });
  return gzipJson(req, { lessons: meta, total });
}

// POST /api/lessons { title, body, projectId?, stack?, personal?, mode?, keywords? } → 레슨 등록 (mode 가 ondemand 가 아니면 컨텍스트 주입에 포함됨)
// keywords = 프롬프트 매칭 단어(소문자 정규화, 2~40자, 30개까지) — 메시지에 있으면 UserPromptSubmit 훅이 이 레슨을 넣는다.
export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  // Idempotency-Key(선택) — lesson import-memory 가 메모리 name 을 키로 보내 재실행해도 중복이 생기지 않는다.
  return withIdempotency(req, guard, async () => {
    const parsed = await readBody(req, LessonBody);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const title = body.title?.trim() ?? "";
    const text = body.body?.trim() ?? "";
    if (!title || !text) {
      return NextResponse.json({ error: "title 과 body 가 필요합니다." }, { status: 400 });
    }
    if (body.projectId) {
      const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { workspaceId: true } });
      if (!project || project.workspaceId !== guard.workspaceId) {
        return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
      }
    }
    const st = parseLessonStack(body.stack ?? null);
    if (!st.ok) return NextResponse.json({ error: st.error }, { status: 400 });
    if (st.stack && body.projectId) {
      return NextResponse.json({ error: "레슨 범위는 프로젝트와 스택 중 하나만 정할 수 있습니다." }, { status: 400 });
    }
    let userId: string | null = null;
    if (body.personal) {
      if (body.projectId || st.stack) return NextResponse.json({ error: PERSONAL_SCOPE_CONFLICT }, { status: 400 });
      userId = viewerPersonId(guard);
      if (!userId) return NextResponse.json({ error: PERSONAL_NEEDS_PERSON }, { status: 400 });
    }
    const md = body.mode === undefined ? null : parseLessonMode(body.mode);
    if (md && !md.ok) return NextResponse.json({ error: md.error }, { status: 400 });
    const kw = normalizeTerms(body.keywords ?? null);
    if (!kw.ok) return NextResponse.json({ error: kw.error }, { status: 400 });
    const lesson = await prisma.lesson.create({
      data: {
        workspaceId: guard.workspaceId,
        projectId: body.projectId ?? null,
        stack: st.stack,
        userId,
        ...(md?.ok ? { mode: md.mode } : {}),
        ...(kw.terms.length ? { keywords: kw.terms } : {}),
        title,
        body: text,
        createdById: guard.userId,
      },
    });
    if (!userId) invalidateGraphCache(guard.workspaceId); // 개인 레슨은 그래프에 넣지 않는다(lib/graphLoad loadRaw)
    return NextResponse.json({ lesson: withLessonMeta(lesson) });
  });
}

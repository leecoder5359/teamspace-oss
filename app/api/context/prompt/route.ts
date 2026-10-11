import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { resolveRouteByCwd } from "@/lib/ingest";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { viewerPersonId } from "@/lib/viewerPerson";
import { matchPromptLessons, PROMPT_MIN_CHARS } from "@/lib/lessonPromptMatch";
import { recordLessonInjection } from "@/lib/lessonInspect/log";

export const runtime = "nodejs";

const Body = z.object({
  prompt: z.string().max(200_000),
  cwd: z.string().max(4096).nullable().optional(),
  sessionId: z.string().max(256).nullable().optional(),
  exclude: z.array(z.string().max(64)).max(1000).optional(),
  /** true = 미리 보기(pnpm ws lesson match) — 기록하지 않고 matches(사유·맞은 키워드)를 함께 준다 */
  preview: z.boolean().optional(),
});

/* POST /api/context/prompt { prompt, cwd?, sessionId?, exclude?, preview? } → { markdown, lessonIds, projectIds[, matches] }
   UserPromptSubmit 훅(scripts/hooks/teamspace-prompt-lessons.mjs)용 — 사용자 메시지에 맞는 레슨만 골라 준다.
   판정은 lib/lessonPromptMatch(키워드·프로젝트 별칭). 필수(required)는 세션 시작에 이미 들어가 있어 빠진다.
   exclude = 이 세션에 이미 넣은 레슨 id. 짧은 메시지(공백 제외 6자 미만)·대상 없음 → markdown "".
   **프롬프트 원문은 저장·로그하지 않는다** — LessonInjection 에는 via=UserPromptSubmit·id·글자 수만.
   제한 프로젝트(볼 수 없는 프로젝트)는 언급해도 열리지 않는다. 인증은 /api/context 와 같다(viewer).
   preview:true = 미리 보기 — 기록 안 함, matches:[{id,title,reason(keyword|mention),hits,shown}] 동봉. */
export async function POST(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const parsed = await readBody(request, Body);
  if (!parsed.ok) return parsed.res;
  const { prompt, cwd, exclude, preview } = parsed.data;
  const none = { markdown: "", lessonIds: [] as string[], projectIds: [] as string[], ...(preview ? { matches: [] } : {}) };
  if (prompt.replace(/\s+/g, "").length < PROMPT_MIN_CHARS) return NextResponse.json(none);

  const [projectsRaw, rules] = await Promise.all([
    prisma.project.findMany({
      where: { workspaceId, archivedAt: null },
      select: { id: true, name: true, aliases: true, stack: true, visibility: true },
    }),
    cwd ? prisma.workspaceRouteRule.findMany({ where: { workspaceId }, select: { cwdPrefix: true, workspaceId: true, projectId: true, priority: true } }) : [],
  ]);
  // 제한 프로젝트가 있을 때만 권한 인덱스를 읽는다(대부분의 워크스페이스는 inherit 뿐 — 메시지마다 부르는 경로라 가볍게).
  let projects = projectsRaw;
  if (projectsRaw.some((p) => p.visibility !== "inherit")) {
    const access = await loadAccess(guard);
    projects = projectsRaw.filter((p) => projectAccess(access, p.id) !== "none");
  }
  const live = new Set(projects.map((p) => p.id));
  const cwdProjectId = resolveRouteByCwd(cwd, rules.filter((r) => !r.projectId || live.has(r.projectId)))?.projectId ?? null;

  const personId = viewerPersonId(guard);
  const lessons = await prisma.lesson.findMany({
    where: {
      workspaceId,
      mode: { in: ["default", "ondemand"] },
      AND: [
        { OR: [{ userId: null }, ...(personId ? [{ userId: personId }] : [])] },
        { OR: [{ projectId: null }, { projectId: { in: [...live] } }] },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, body: true, projectId: true, stack: true, userId: true, mode: true, keywords: true, updatedAt: true },
    take: 1000,
  });

  const r = matchPromptLessons({ prompt, lessons, projects, cwdProjectId, personId, exclude });
  if (r.lessonIds.length && !preview) {
    void recordLessonInjection({
      workspaceId,
      actorName: guard.actor?.name,
      cwd: cwd ?? null,
      projectId: cwdProjectId,
      via: "UserPromptSubmit",
      mode: "prompt",
      ids: { gistIds: r.lessonIds, titleIds: [], omittedIds: [] },
      chars: r.markdown.length,
    });
  }
  const shown = new Set(r.lessonIds);
  const matches = preview
    ? { matches: r.ranked.map((e) => ({ id: e.lesson.id, title: e.lesson.title, reason: e.reason, hits: e.hits, shown: shown.has(e.lesson.id) })) }
    : {};
  return NextResponse.json(
    { markdown: r.markdown, lessonIds: r.lessonIds, projectIds: r.mentionedProjectIds, cwdProjectId, ...matches },
    { headers: { "Cache-Control": "no-store" } },
  );
}

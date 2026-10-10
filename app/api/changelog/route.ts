import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { z } from "zod";

const ChangelogBody = z.object({
  version: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

export const runtime = "nodejs";

// GET /api/changelog[?project=<id>|none] → 릴리스 노트(최신순). project 없음=전부, none=공용(projectId null)만.
// D3: 볼 수 없는 프로젝트의 항목은 제목·본문이 새므로 목록에서 뺀다(공용 항목은 모두에게 보인다).
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const project = new URL(request.url).searchParams.get("project")?.trim() || undefined;
  // take 200 이 D3 필터보다 먼저 적용되면 숨겨진 항목이 자리를 먹어 보이는 항목이 잘린다 — 허용 프로젝트를 where 에 넣는다.
  const idx = await loadAccess(guard);
  const allowed = [...idx.projects.keys()].filter((id) => projectAccess(idx, id) !== "none");
  const where = {
    workspaceId,
    OR: [{ projectId: null }, { projectId: { in: allowed } }],
    ...(project ? { projectId: project === "none" ? null : project } : {}),
  };
  const entries = await prisma.changelogEntry.findMany({ where, orderBy: { releasedAt: "desc" }, take: 200 });
  return NextResponse.json({ entries });
}

// POST /api/changelog → 릴리스 노트 추가
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const parsed = await readBody(request, ChangelogBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  const ref = await resolveProjectRef(body.projectId, workspaceId);
  if (!ref.ok) return ref.err;
  // D3: 편집 권한이 없는 프로젝트(숨김·보기 전용)는 없는 프로젝트와 같은 문구로 거절해 존재를 흘리지 않는다.
  if (ref.projectId && projectAccess(await loadAccess(guard), ref.projectId) !== "edit") {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다.", projectId: ref.projectId }, { status: 400 });
  }
  const created = await prisma.changelogEntry.create({
    data: { workspaceId, projectId: ref.projectId, version: body.version?.trim() || null, title, body: body.body?.trim() || null },
  });
  return NextResponse.json({ id: created.id });
}

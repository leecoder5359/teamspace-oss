import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, pageAccess } from "@/lib/pageGuard";
import { listVisits, recordVisit } from "@/lib/favorites";
import { loadArchivedPageIds } from "@/lib/pageArchive";

const KEEP = 20; // 사람당 보관 개수

export async function GET(request: Request) {
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;
  const sp = new URL(request.url).searchParams;
  const limit = Math.min(KEEP, Math.max(1, Number(sp.get("limit") ?? 8) || 8));
  const includeArchived = sp.get("archived") === "1";
  // 다른 워크스페이스 페이지는 쿼리에서, 볼 수 없는 페이지는 접근 색인("none")에서 빠진다.
  // admin 은 pageAccess 가 id 와 무관하게 "edit" 이라 워크스페이스 조건을 쿼리에 직접 건다.
  const visits = await listVisits(guard.userId, guard.workspaceId, KEEP);
  const access = await loadAccess(guard);
  // 보관된 페이지(조상 규칙)는 기본 목록에서 뺀다(?archived=1 이면 포함). 가시성 먼저, 그다음 보관 — limit 은 남은 것 기준.
  const archived = includeArchived ? new Set<string>() : await loadArchivedPageIds(prisma, guard.workspaceId);
  const vis = visits.filter((v) => pageAccess(access, v.pageId) !== "none" && !archived.has(v.pageId)).slice(0, limit);
  const pages = await prisma.page.findMany({
    where: { id: { in: vis.map((v) => v.pageId) }, workspaceId: guard.workspaceId, deletedAt: null },
    select: { id: true, title: true, kind: true, docType: true, projectId: true },
  });
  const byId = new Map(pages.map((p) => [p.id, p]));
  return NextResponse.json({
    visits: vis.flatMap((v) => {
      const p = byId.get(v.pageId);
      return p
        ? [{ pageId: p.id, title: p.title, kind: p.kind, docType: p.docType, projectId: p.projectId, visitedAt: v.visitedAt }]
        : [];
    }),
  });
}

const PostBody = z.object({ pageId: z.string().min(1) });
export async function POST(request: Request) {
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;
  const parsed = PostBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "pageId 가 필요합니다." }, { status: 400 });
  const access = await loadAccess(guard);
  if (pageAccess(access, parsed.data.pageId) === "none") {
    return NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 });
  }
  // admin 은 pageAccess 가 존재 여부와 무관하게 "edit" 이라 FK 500 이 난다 — 실재·같은 워크스페이스를 따로 확인.
  const exists = await prisma.page.findFirst({
    where: { id: parsed.data.pageId, workspaceId: guard.workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!exists) return NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 });
  await recordVisit(guard.userId, parsed.data.pageId, KEEP);
  return NextResponse.json({ ok: true });
}

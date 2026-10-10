import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, pageAccess } from "@/lib/pageGuard";
import { listFavorites, addFavorite, removeFavorite, reorderFavorites } from "@/lib/favorites";
import { loadArchivedPageIds } from "@/lib/pageArchive";

// 사람별 즐겨찾기. 목록은 필터(D3): 볼 수 없는 페이지는 응답에서 뺀다. 단건 추가는 404 게이트.
// 보관된 페이지(조상 규칙)는 목록에서 뺀다(?archived=1 이면 포함). 추가(POST)는 보관 페이지도 허용.
const SELECT = { id: true, title: true, kind: true, docType: true, projectId: true } as const;

export async function GET(request: Request) {
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;
  const includeArchived = new URL(request.url).searchParams.get("archived") === "1";
  const favs = await listFavorites(guard.userId, guard.workspaceId);
  const access = await loadAccess(guard);
  // 가시성 먼저, 보관 제외는 그다음(D3 — 보관 제외가 가시성을 넓히지 않는다).
  const archived = includeArchived ? new Set<string>() : await loadArchivedPageIds(prisma, guard.workspaceId);
  const ids = favs.map((f) => f.pageId).filter((id) => pageAccess(access, id) !== "none" && !archived.has(id));
  const pages = await prisma.page.findMany({ where: { id: { in: ids }, deletedAt: null }, select: SELECT });
  const byId = new Map(pages.map((p) => [p.id, p]));
  const favorites = ids.flatMap((id) => {
    const p = byId.get(id);
    return p ? [{ pageId: p.id, title: p.title, kind: p.kind, docType: p.docType, projectId: p.projectId }] : [];
  });
  return NextResponse.json({ favorites });
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
  await addFavorite(guard.userId, parsed.data.pageId);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;
  const pageId = new URL(request.url).searchParams.get("pageId");
  if (!pageId) return NextResponse.json({ error: "pageId 가 필요합니다." }, { status: 400 });
  await removeFavorite(guard.userId, pageId);
  return NextResponse.json({ ok: true });
}

const PatchBody = z.object({ order: z.array(z.string().min(1)).max(200) });
export async function PATCH(request: Request) {
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;
  const parsed = PatchBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "order 배열이 필요합니다." }, { status: 400 });
  await reorderFavorites(guard.userId, parsed.data.order);
  return NextResponse.json({ ok: true });
}

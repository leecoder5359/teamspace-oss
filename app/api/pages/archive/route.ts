import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { loadAccess, gatePage, notFound } from "@/lib/pageGuard";
import { recordActivity } from "@/lib/activity";
import { invalidateGraphCache } from "@/lib/graphLoad";

export const runtime = "nodejs";

const Body = z.object({ id: z.string().min(1), archived: z.boolean() });

// POST /api/pages/archive { id, archived } → 문서 보관/해제 (F2).
// 휴지통(deletedAt)과 달리 삭제가 아니라 '치워두기' — 사이드바·목록·검색 기본 제외, 복귀는 archived:false.
// database 종류도 보관할 수 있다(행은 그대로). 자손은 건드리지 않는다: 부모가 보관되면
// 자식은 사이드바에서 루트로 올라온다(부모 없는 노드는 루트로 그려짐).
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const parsed = await readBody(request, Body);
  if (!parsed.ok) return parsed.res;
  const { id, archived } = parsed.data;

  // D3: 볼 수 없는 페이지는 없는 것과 같은 404 (편집 권한 없으면 403)
  const gate = gatePage(await loadAccess(guard), id, "edit");
  if ("err" in gate) return gate.err;
  const page = await prisma.page.findFirst({
    where: { id, workspaceId: guard.workspaceId, deletedAt: null },
    select: { id: true, title: true, archivedAt: true, updatedAt: true },
  });
  if (!page) return notFound();

  // 이미 그 상태면 쓰지 않는다(보관 시각을 덮어쓰지 않고 활동 기록도 중복시키지 않음)
  if (archived === (page.archivedAt !== null)) {
    return NextResponse.json({ page: { id, archived, archivedAt: page.archivedAt?.toISOString() ?? null }, changed: false });
  }
  // 보관은 내용 수정이 아니다 — @updatedAt 이 '마지막 수정' 을 덮지 않도록 기존 값을 그대로 넘긴다.
  const updated = await prisma.page.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null, updatedAt: page.updatedAt },
    select: { archivedAt: true },
  });
  // 지식 그래프는 보관 문서를 노드에서 빼므로 상태가 바뀌면 캐시를 즉시 버린다(TTL 을 기다리지 않게).
  invalidateGraphCache(guard.workspaceId);
  recordActivity(guard, archived ? "archived" : "unarchived", "page", page.title, id);
  return NextResponse.json({ page: { id, archived, archivedAt: updated.archivedAt?.toISOString() ?? null }, changed: true });
}

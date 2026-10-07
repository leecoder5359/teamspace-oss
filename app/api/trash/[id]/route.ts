import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { recordActivity } from "@/lib/activity";
import { resolveDocPath } from "@/lib/docFiles";
import { deleteContent } from "@/lib/content";
import { invalidateGraphCache } from "@/lib/graphLoad";

export const runtime = "nodejs";

// POST /api/trash/[id] → 복원. 부모가 삭제 상태면 루트로 복원한다.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  // D3: 복원·영구삭제도 그 페이지를 편집할 수 있어야 한다.
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;

  const page = await prisma.page.findUnique({
    where: { id },
    include: { parent: { select: { deletedAt: true } } },
  });
  if (!page || page.workspaceId !== guard.workspaceId || !page.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parentGone = page.parentId !== null && (!page.parent || page.parent.deletedAt !== null);
  await prisma.page.update({
    where: { id },
    data: { deletedAt: null, ...(parentGone ? { parentId: null } : {}) },
  });
  invalidateGraphCache(guard.workspaceId);
  recordActivity(guard, "restored", page.kind === "database" ? "board" : "doc", page.title, id);
  return NextResponse.json({ ok: true, movedToRoot: parentGone });
}

// 페이지 본문 파일 삭제(종류별 저장소 분기). 파일 부재는 무시(레질리언트).
async function deletePageFile(page: { kind: string; filePath: string | null; title: string }) {
  if (!page.filePath) return;
  try {
    if (page.kind === "doc") {
      await fs.unlink(resolveDocPath(page.filePath));
    } else {
      await deleteContent(page.filePath, `delete: ${page.title}`);
    }
  } catch {
    // 파일 부재/경로 불일치는 삭제를 막지 않음
  }
}

// DELETE /api/trash/[id] → 영구 삭제(이때만 md 파일 unlink). 휴지통에 있는 페이지만 허용.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  // D3: 복원·영구삭제도 그 페이지를 편집할 수 있어야 한다.
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;

  const page = await prisma.page.findUnique({ where: { id }, include: { children: true } });
  if (!page || page.workspaceId !== guard.workspaceId || !page.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // 살아 있는 자식이 남아 있으면 구조 파괴 — 거부(자식 먼저 정리)
  if (page.children.some((c) => !c.deletedAt)) {
    return NextResponse.json({ error: "살아 있는 하위 페이지가 있어 영구 삭제할 수 없습니다." }, { status: 409 });
  }
  // 삭제된 자식은 루트로 승격시켜 개별적으로 휴지통에 남긴다(연쇄 하드 삭제 방지)
  await prisma.$transaction([
    prisma.page.updateMany({
      where: { parentId: id, deletedAt: { not: null } },
      data: { parentId: null },
    }),
    // GraphEdge 는 끝점 FK 가 없다 — 같은 트랜잭션에서 고아 간선(LLM related 등)을 함께 지운다
    prisma.graphEdge.deleteMany({ where: { workspaceId: guard.workspaceId, OR: [{ fromId: id }, { toId: id }] } }),
    prisma.page.delete({ where: { id } }),
  ]);
  invalidateGraphCache(guard.workspaceId);
  await deletePageFile(page);
  recordActivity(guard, "purged", page.kind === "database" ? "board" : "doc", page.title, id);
  return NextResponse.json({ ok: true });
}

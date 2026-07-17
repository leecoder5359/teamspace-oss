import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { notifyTaskCreated } from "@/lib/notify";
import { recordActivity } from "@/lib/activity";
import { withIdempotency } from "@/lib/idempotency";

// POST /api/databases/[id]/rows → 새 행 생성
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as { props?: Record<string, unknown> };

  const db = await prisma.page.findUnique({ where: { id }, select: { kind: true, workspaceId: true, deletedAt: true } });
  if (!db || db.kind !== "database" || db.workspaceId !== guard.workspaceId || db.deletedAt) {
    return NextResponse.json({ error: "Not a database" }, { status: 404 });
  }
  return withIdempotency(req, guard, async () => {

  const last = await prisma.dbRow.findFirst({
    where: { databasePageId: id },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = (last?.position ?? -1) + 1;

  const row = await prisma.dbRow.create({
    data: { databasePageId: id, props: (body.props ?? {}) as object, position, updatedById: guard.userId },
  });
  void notifyTaskCreated(id, (body.props ?? {}) as Record<string, unknown>);
  const firstText = Object.values((body.props ?? {}) as Record<string, unknown>).find((v) => typeof v === "string" && v);
  recordActivity(guard, "created", "task", (firstText as string) ?? "(제목 없음)", row.id);
  return NextResponse.json({ row });
  });
}

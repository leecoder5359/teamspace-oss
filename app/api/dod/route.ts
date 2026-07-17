import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const items = await prisma.dodItem.findMany({ where: { workspaceId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], take: 300 });
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const b = (await request.json().catch(() => ({}))) as { text?: string };
  const text = b.text?.trim();
  if (!text) return NextResponse.json({ error: "항목을 입력해 주세요." }, { status: 400 });
  const last = await prisma.dodItem.findFirst({ where: { workspaceId }, orderBy: { position: "desc" }, select: { position: true } });
  const created = await prisma.dodItem.create({ data: { workspaceId, text, position: (last?.position ?? -1) + 1 } });
  return NextResponse.json({ id: created.id });
}

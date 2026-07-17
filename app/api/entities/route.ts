import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const entities = await prisma.entity.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, take: 300 });
  return NextResponse.json({ entities });
}

export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const b = (await request.json().catch(() => ({}))) as { name?: string; description?: string; fields?: string; sourcePageId?: string };
  const name = b.name?.trim();
  if (!name) return NextResponse.json({ error: "엔티티 이름을 입력해 주세요." }, { status: 400 });
  const created = await prisma.entity.create({
    data: { workspaceId, name, description: b.description?.trim() || null, fields: b.fields?.trim() || null, sourcePageId: b.sourcePageId?.trim() || null },
  });
  return NextResponse.json({ id: created.id });
}

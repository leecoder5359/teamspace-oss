import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";
const ST = ["pending", "pass", "fail"] as const;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.qaScenario.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { status?: string };
  if (!(ST as readonly string[]).includes(b.status ?? "")) return NextResponse.json({ error: "invalid" }, { status: 400 });
  await prisma.qaScenario.update({ where: { id }, data: { status: b.status as "pending" | "pass" | "fail" } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.qaScenario.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}

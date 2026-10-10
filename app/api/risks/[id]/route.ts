import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const RiskPatchBody = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  severity: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().optional(),
});

export const runtime = "nodejs";
const ST = ["open", "mitigated", "closed"] as const;
const SEV = ["low", "medium", "high"] as const;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.risk.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = await readBody(req, RiskPatchBody);
  if (!parsed.ok) return parsed.res;
  const b = parsed.data;
  if (b.status !== undefined && !(ST as readonly string[]).includes(b.status)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (b.severity !== undefined && !(SEV as readonly string[]).includes(b.severity)) {
    return NextResponse.json({ error: "invalid severity" }, { status: 400 });
  }
  if (b.title !== undefined && !b.title.trim()) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  let projectPatch: { projectId: string | null } | Record<string, never> = {};
  if (b.projectId !== undefined) {
    if (!b.projectId.trim()) projectPatch = { projectId: null };
    else {
      const proj = await prisma.project.findFirst({ where: { id: b.projectId, workspaceId }, select: { id: true } });
      if (!proj) return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
      projectPatch = { projectId: proj.id };
    }
  }
  await prisma.risk.update({
    where: { id },
    data: {
      ...(b.title !== undefined ? { title: b.title.trim() } : {}),
      ...(b.description !== undefined ? { description: b.description.trim() || null } : {}),
      ...(b.severity !== undefined ? { severity: b.severity as "low" | "medium" | "high" } : {}),
      ...(b.status !== undefined ? { status: b.status as "open" | "mitigated" | "closed" } : {}),
      ...projectPatch,
    },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.risk.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}

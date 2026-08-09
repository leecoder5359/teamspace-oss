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
  const b = (await req.json().catch(() => ({}))) as {
    title?: string; steps?: string; expected?: string; status?: string; projectId?: string;
  };
  // status 는 주어졌을 때만 검증한다 — 종전엔 status 없이 다른 필드만 고치려 하면 400 이었다.
  if (b.status !== undefined && !(ST as readonly string[]).includes(b.status)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  if (b.title !== undefined && !b.title.trim()) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  // projectId 는 이 워크스페이스 것만 인정. 빈 문자열이면 프로젝트 해제.
  let projectPatch: { projectId: string | null } | Record<string, never> = {};
  if (b.projectId !== undefined) {
    if (!b.projectId.trim()) projectPatch = { projectId: null };
    else {
      const proj = await prisma.project.findFirst({ where: { id: b.projectId, workspaceId }, select: { id: true } });
      if (!proj) return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
      projectPatch = { projectId: proj.id };
    }
  }
  await prisma.qaScenario.update({
    where: { id },
    data: {
      ...(b.title !== undefined ? { title: b.title.trim() } : {}),
      ...(b.steps !== undefined ? { steps: b.steps.trim() || null } : {}),
      ...(b.expected !== undefined ? { expected: b.expected.trim() || null } : {}),
      ...(b.status !== undefined ? { status: b.status as "pending" | "pass" | "fail" } : {}),
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
  await prisma.qaScenario.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}

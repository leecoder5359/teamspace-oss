import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";
const ST = ["pending", "pass", "fail"] as const;

export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const projectId = new URL(request.url).searchParams.get("projectId");
  const scenarios = await prisma.qaScenario.findMany({
    where: { workspaceId, ...(projectId ? { projectId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { project: { select: { name: true, color: true } } },
  });
  return NextResponse.json({ scenarios });
}

export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const b = (await request.json().catch(() => ({}))) as {
    title?: string; steps?: string; expected?: string; status?: string; projectId?: string;
  };
  const title = b.title?.trim();
  if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  let projectId: string | null = null;
  if (b.projectId) {
    const p = await prisma.project.findFirst({ where: { id: b.projectId, workspaceId }, select: { id: true } });
    projectId = p?.id ?? null;
  }
  const created = await prisma.qaScenario.create({
    data: {
      workspaceId, projectId, title,
      steps: b.steps?.trim() || null,
      expected: b.expected?.trim() || null,
      status: (ST as readonly string[]).includes(b.status ?? "") ? (b.status as "pending" | "pass" | "fail") : "pending",
    },
  });
  return NextResponse.json({ id: created.id });
}

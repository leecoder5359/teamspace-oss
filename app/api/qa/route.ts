import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const QaBody = z.object({
  title: z.string().optional(),
  steps: z.string().optional(),
  expected: z.string().optional(),
  status: z.string().optional(),
  projectId: z.string().optional(),
});

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
  const parsed = await readBody(request, QaBody);
  if (!parsed.ok) return parsed.res;
  const b = parsed.data;
  const title = b.title?.trim();
  if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  // 없는/남의 프로젝트는 조용히 null 로 버리지 않고 400 으로 알린다(D5)
  const ref = await resolveProjectRef(b.projectId, workspaceId);
  if (!ref.ok) return ref.err;
  const projectId = ref.projectId;
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

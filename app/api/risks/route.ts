import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

const SEV = ["low", "medium", "high"] as const;
const ST = ["open", "mitigated", "closed"] as const;

export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const projectId = new URL(request.url).searchParams.get("projectId");
  const risks = await prisma.risk.findMany({
    where: { workspaceId, ...(projectId ? { projectId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { project: { select: { name: true, color: true } } },
  });
  return NextResponse.json({ risks });
}

export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const b = (await request.json().catch(() => ({}))) as {
    title?: string; description?: string; severity?: string; status?: string; projectId?: string;
  };
  const title = b.title?.trim();
  if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  // 없는/남의 프로젝트는 조용히 null 로 버리지 않고 400 으로 알린다(D5)
  const ref = await resolveProjectRef(b.projectId, workspaceId);
  if (!ref.ok) return ref.err;
  const projectId = ref.projectId;
  const created = await prisma.risk.create({
    data: {
      workspaceId, projectId, title,
      description: b.description?.trim() || null,
      severity: (SEV as readonly string[]).includes(b.severity ?? "") ? (b.severity as "low" | "medium" | "high") : "medium",
      status: (ST as readonly string[]).includes(b.status ?? "") ? (b.status as "open" | "mitigated" | "closed") : "open",
    },
  });
  return NextResponse.json({ id: created.id });
}

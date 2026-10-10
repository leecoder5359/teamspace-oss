import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const TeamBody = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
});

export const runtime = "nodejs";

const COLORS = ["blue", "orange", "purple", "green", "red", "gray"];

// GET /api/teams → 현재 워크스페이스 팀 목록 (멤버 수 포함)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const teams = await prisma.team.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { members: true } } },
  });
  return NextResponse.json({
    teams: teams.map((t) => ({ id: t.id, name: t.name, color: t.color, memberCount: t._count.members })),
  });
}

// POST /api/teams → 팀 생성 { name, color? }
export async function POST(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const parsed = await readBody(request, TeamBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "팀 이름을 입력해 주세요." }, { status: 400 });
  const color = body.color && COLORS.includes(body.color) ? body.color : "blue";
  const team = await prisma.team.create({ data: { workspaceId, name, color } });
  return NextResponse.json({ team: { id: team.id, name: team.name, color: team.color, memberCount: 0 } });
}

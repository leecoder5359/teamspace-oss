import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMemberRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { getProjectsWithStats } from "@/lib/projects";
import { readBody } from "@/lib/apiBody";
import type { ArchivedMode } from "@/lib/pagesList";
import { z } from "zod";

const ProjectBody = z.object({
  name: z.string().optional(),
  short: z.string().optional(),
  color: z.string().optional(),
  description: z.string().optional(),
  leadId: z.string().optional(),
  repoUrl: z.string().optional(),
  repoPath: z.string().optional(),
  repoBranch: z.string().optional(),
  docsDir: z.string().optional(),
});

const COLORS = ["blue", "orange", "purple", "green", "red", "gray"];

// GET /api/projects → 현재 워크스페이스 프로젝트 + 카드 지표
// ?archived=1 → 보관함만 · ?archived=all → 둘 다 · 생략 → 활성만(F10). 모든 select 소비자가 보관 프로젝트를 안 보게 하는 한 곳.
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const q = new URL(request.url).searchParams.get("archived");
  const mode: ArchivedMode = q === "all" ? "all" : q === "1" || q === "true" ? "only" : "active";
  const projects = await getProjectsWithStats(workspaceId, mode);
  // D3: 잠긴 프로젝트는 목록에서도 빠진다(이름·지표 자체가 정보다).
  const idx = await loadAccess(guard);
  return NextResponse.json({ projects: projects.filter((p) => projectAccess(idx, p.id) !== "none") });
}

// POST /api/projects → 프로젝트 생성
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const parsed = await readBody(request, ProjectBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const name = body.name?.trim() ?? "";
  if (!name) {
    return NextResponse.json({ error: "프로젝트 이름을 입력해 주세요." }, { status: 400 });
  }

  const color = body.color && COLORS.includes(body.color) ? body.color : "blue";

  // 멤버가 아니면 조용히 버리지 않고 400 — 리드를 지정했다고 믿는 호출자를 속이지 않는다(D5)
  const lead = await resolveMemberRef(body.leadId, workspaceId, "프로젝트 리드");
  if (!lead.ok) return lead.err;
  const leadId = lead.userId;

  const last = await prisma.project.findFirst({
    where: { workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId,
      name,
      short: body.short?.trim() || null,
      color,
      description: body.description?.trim() || null,
      repoUrl: body.repoUrl?.trim() || null,
      repoPath: body.repoPath?.trim() || null,
      repoBranch: body.repoBranch?.trim() || null,
      docsDir: body.docsDir?.trim() || null,
      leadId,
      position: (last?.position ?? -1) + 1,
    },
  });

  return NextResponse.json({ projectId: project.id });
}

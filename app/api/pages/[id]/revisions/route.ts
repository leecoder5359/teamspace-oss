import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { writeDoc } from "@/lib/docFiles";

export const runtime = "nodejs";

// GET /api/pages/[id]/revisions → 버전 히스토리 목록(최신순, 본문 제외 메타만).
//   ?rev=<n> 이면 해당 버전의 본문 포함 단건 반환.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;

  const page = await prisma.page.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!page || page.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const revParam = new URL(req.url).searchParams.get("rev");
  if (revParam) {
    const rev = Number(revParam);
    const r = await prisma.pageRevision.findUnique({
      where: { pageId_rev: { pageId: id, rev } },
    });
    if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ revision: r });
  }

  const revisions = await prisma.pageRevision.findMany({
    where: { pageId: id },
    select: { rev: true, title: true, authorId: true, createdAt: true },
    orderBy: { rev: "desc" },
    take: 100,
  });
  // 작성자 이름 매핑 (사람/에이전트 공통 User)
  const authorIds = [...new Set(revisions.map((r) => r.authorId).filter((x): x is string => !!x))];
  const users = authorIds.length
    ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return NextResponse.json({
    revisions: revisions.map((r) => ({ ...r, authorName: r.authorId ? (nameOf.get(r.authorId) ?? null) : null })),
  });
}

// POST /api/pages/[id]/revisions { rev } → 해당 버전으로 복원.
//   복원도 새 리비전으로 적재된다(히스토리 비파괴) — 내부적으로 PUT 과 동일한 저장 경로.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;
  const parsedBody = await readBody(req, z.object({ rev: z.number().optional() }));
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data;
  if (typeof body.rev !== "number") {
    return NextResponse.json({ error: "rev 가 필요합니다." }, { status: 400 });
  }

  const page = await prisma.page.findUnique({ where: { id }, select: { workspaceId: true, deletedAt: true } });
  if (!page || page.workspaceId !== guard.workspaceId || page.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const target = await prisma.pageRevision.findUnique({
    where: { pageId_rev: { pageId: id, rev: body.rev } },
  });
  if (!target) return NextResponse.json({ error: "해당 버전이 없습니다." }, { status: 404 });

  const full = await prisma.page.findUnique({ where: { id } });
  if (!full) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const nextRev = full.rev + 1;
  if (full.kind === "doc" && full.filePath) {
    await writeDoc(full.filePath, target.markdown);
  }
  await prisma.$transaction([
    prisma.page.update({
      where: { id },
      data: { markdown: target.markdown, title: target.title, rev: nextRev },
    }),
    prisma.pageRevision.create({
      data: { pageId: id, rev: nextRev, title: target.title, markdown: target.markdown, authorId: guard.userId },
    }),
  ]);
  return NextResponse.json({ ok: true, rev: nextRev, restoredFrom: body.rev });
}

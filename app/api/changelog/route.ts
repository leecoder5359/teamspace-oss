import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/changelog → 릴리스 노트(최신순)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const entries = await prisma.changelogEntry.findMany({ where: { workspaceId }, orderBy: { releasedAt: "desc" }, take: 200 });
  return NextResponse.json({ entries });
}

// POST /api/changelog → 릴리스 노트 추가
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { version?: string; title?: string; body?: string };
  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  const created = await prisma.changelogEntry.create({
    data: { workspaceId, version: body.version?.trim() || null, title, body: body.body?.trim() || null },
  });
  return NextResponse.json({ id: created.id });
}

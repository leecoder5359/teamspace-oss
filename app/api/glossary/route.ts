import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/glossary → 용어 목록(가나다/알파벳순)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const terms = await prisma.glossaryTerm.findMany({ where: { workspaceId }, orderBy: { term: "asc" }, take: 500 });
  return NextResponse.json({ terms });
}

// POST /api/glossary → 용어 추가
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { term?: string; definition?: string; sourcePageId?: string };
  const term = body.term?.trim();
  const definition = body.definition?.trim();
  const sourcePageId = body.sourcePageId?.trim() || null;
  if (!term || !definition) return NextResponse.json({ error: "용어와 정의를 입력해 주세요." }, { status: 400 });
  const created = await prisma.glossaryTerm.create({ data: { workspaceId, term, definition, sourcePageId } });
  return NextResponse.json({ id: created.id });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

const TYPES = ["text", "number", "date", "select", "multiselect", "checkbox", "person", "relation"] as const;
type PropTypeStr = (typeof TYPES)[number];

async function loadBoard(id: string, workspaceId: string) {
  const page = await prisma.page.findUnique({
    where: { id },
    select: { kind: true, workspaceId: true, deletedAt: true },
  });
  if (!page || page.kind !== "database" || page.workspaceId !== workspaceId || page.deletedAt) return null;
  return page;
}

// POST /api/databases/[id]/properties { name, type, config? } → 속성 추가 (W5 task-7)
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  if (!(await loadBoard(id, guard.workspaceId))) {
    return NextResponse.json({ error: "Not a database" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    type?: PropTypeStr;
    config?: object;
  };
  const name = body.name?.trim() ?? "";
  if (!name) return NextResponse.json({ error: "name 이 필요합니다." }, { status: 400 });
  if (!body.type || !TYPES.includes(body.type)) {
    return NextResponse.json({ error: `type 은 ${TYPES.join("/")} 중 하나여야 합니다.` }, { status: 400 });
  }
  const dup = await prisma.dbProperty.findFirst({ where: { databasePageId: id, name }, select: { id: true } });
  if (dup) return NextResponse.json({ error: "같은 이름의 속성이 이미 있습니다." }, { status: 409 });

  const last = await prisma.dbProperty.findFirst({
    where: { databasePageId: id },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  // select 계열 기본 config: 빈 옵션 목록
  const config = body.config ?? (body.type === "select" || body.type === "multiselect" ? { options: [] } : {});
  const property = await prisma.dbProperty.create({
    data: { databasePageId: id, name, type: body.type, config: config as object, position: (last?.position ?? -1) + 1 },
  });
  return NextResponse.json({ property });
}

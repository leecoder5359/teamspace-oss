import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

type Opt = { id: string; name: string; color?: string };

async function loadProp(boardId: string, propId: string, workspaceId: string) {
  const prop = await prisma.dbProperty.findUnique({
    where: { id: propId },
    include: { database: { select: { workspaceId: true, kind: true, deletedAt: true } } },
  });
  if (
    !prop ||
    prop.databasePageId !== boardId ||
    prop.database.workspaceId !== workspaceId ||
    prop.database.kind !== "database" ||
    prop.database.deletedAt
  ) {
    return null;
  }
  return prop;
}

// PATCH /api/databases/[id]/properties/[propId] { name?, addOption?{name,color?}, renameOption?{id,name} }
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; propId: string }> }) {
  const { id, propId } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const prop = await loadProp(id, propId, guard.workspaceId);
  if (!prop) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    addOption?: { name?: string; color?: string };
    renameOption?: { id?: string; name?: string };
  };

  const data: { name?: string; config?: object } = {};
  if (body.name !== undefined) {
    const n = body.name.trim();
    if (!n) return NextResponse.json({ error: "name 이 비었습니다." }, { status: 400 });
    data.name = n;
  }

  if (body.addOption || body.renameOption) {
    if (prop.type !== "select" && prop.type !== "multiselect") {
      return NextResponse.json({ error: "옵션은 select/multiselect 속성에서만." }, { status: 400 });
    }
    const config = (prop.config ?? {}) as { options?: Opt[] };
    const options = [...(config.options ?? [])];
    if (body.addOption) {
      const n = body.addOption.name?.trim() ?? "";
      if (!n) return NextResponse.json({ error: "옵션 이름이 필요합니다." }, { status: 400 });
      if (options.some((o) => o.name === n)) {
        return NextResponse.json({ error: "같은 이름의 옵션이 이미 있습니다." }, { status: 409 });
      }
      options.push({ id: randomUUID(), name: n, color: body.addOption.color ?? "gray" });
    }
    if (body.renameOption) {
      const target = options.find((o) => o.id === body.renameOption?.id);
      const n = body.renameOption.name?.trim() ?? "";
      if (!target || !n) return NextResponse.json({ error: "옵션을 찾을 수 없거나 이름이 비었습니다." }, { status: 400 });
      target.name = n;
    }
    data.config = { ...config, options };
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "변경할 내용이 없습니다." }, { status: 400 });
  }
  const updated = await prisma.dbProperty.update({ where: { id: propId }, data });
  return NextResponse.json({ property: updated });
}

// DELETE /api/databases/[id]/properties/[propId] — 행 props 의 값은 남지만 무해(표시 안 됨)
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; propId: string }> }) {
  const { id, propId } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const prop = await loadProp(id, propId, guard.workspaceId);
  if (!prop) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.dbProperty.delete({ where: { id: propId } });
  return NextResponse.json({ ok: true });
}

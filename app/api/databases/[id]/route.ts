import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { safeParseDbPropertyConfig } from "@/lib/dbConfig";

// GET /api/databases/[id] → database 페이지 메타 + 속성/뷰/행 일괄
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const page = await prisma.page.findUnique({
    where: { id },
    select: { id: true, title: true, kind: true, workspaceId: true, deletedAt: true, project: { select: { id: true, name: true, color: true } } },
  });
  if (!page || page.kind !== "database" || page.workspaceId !== guard.workspaceId || page.deletedAt) {
    return NextResponse.json({ error: "Not a database" }, { status: 404 });
  }

  const [properties, views, rows] = await Promise.all([
    prisma.dbProperty.findMany({ where: { databasePageId: id }, orderBy: { position: "asc" } }),
    prisma.dbView.findMany({ where: { databasePageId: id }, orderBy: { position: "asc" } }),
    prisma.dbRow.findMany({ where: { databasePageId: id }, orderBy: { position: "asc" } }),
  ]);

  // multiselect/person 속성의 config 형태를 검증(비파괴적: 실패해도 경고만, 출력은 유지).
  for (const p of properties) {
    const parsed = safeParseDbPropertyConfig(p.type, p.config);
    if (!parsed.success) {
      console.warn(`[dbConfig] invalid ${p.type} config on property ${p.id}:`, parsed.error.issues);
    }
  }

  return NextResponse.json({ page, properties, views, rows });
}

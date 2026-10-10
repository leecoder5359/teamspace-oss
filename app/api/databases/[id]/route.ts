import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { safeParseDbPropertyConfig } from "@/lib/dbConfig";
import { withReq } from "@/lib/log";

// GET /api/databases/[id] → database 페이지 메타 + 속성/뷰/행 일괄
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  // D3: 보드도 페이지다 — 같은 게이트를 통과해야 한다.
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;
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
      withReq(req).warn("db.property_config_invalid", { msg: "속성 config 형태가 잘못됨(출력은 유지)", propertyId: p.id, type: p.type, issues: parsed.error.issues });
    }
  }

  // 만든/수정한 사람 열을 그리려면 id 가 아니라 이름이 필요하다. 행마다 조회하면
  // N+1 이 되므로 등장한 id 만 한 번에 모아 보낸다(격차 C3).
  const actorIds = [...new Set(rows.flatMap((r) => [r.createdById, r.updatedById]).filter((v): v is string => !!v))];
  const actors = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const users = Object.fromEntries(actors.map((u) => [u.id, u.name ?? u.email ?? u.id]));

  return NextResponse.json({ page, properties, views, rows, users });
}

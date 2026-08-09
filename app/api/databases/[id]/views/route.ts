import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { sanitizeViewConfig } from "./[viewId]/route";

export const runtime = "nodejs";

// 격차 C1: 표·칸반 2종뿐이던 것에 갤러리·리스트·달력·타임라인 추가.
const VIEW_TYPES = ["table", "kanban", "gallery", "list", "calendar", "timeline"] as const;

// GET /api/databases/[id]/views → 이 보드의 뷰 목록
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  // D3: 보드도 페이지다 — 같은 게이트를 통과해야 한다.
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;

  const db = await prisma.page.findFirst({
    where: { id, workspaceId: guard.workspaceId, kind: "database", deletedAt: null },
    select: { id: true },
  });
  if (!db) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const views = await prisma.dbView.findMany({ where: { databasePageId: id }, orderBy: { position: "asc" } });
  return NextResponse.json({ views });
}

// POST /api/databases/[id]/views { name, type?, config? } → 뷰 추가
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;

  const db = await prisma.page.findFirst({
    where: { id, workspaceId: guard.workspaceId, kind: "database", deletedAt: null },
    select: { id: true },
  });
  if (!db) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { name?: string; type?: string; config?: unknown };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "뷰 이름을 입력해 주세요." }, { status: 400 });
  if (body.type !== undefined && !(VIEW_TYPES as readonly string[]).includes(body.type)) {
    return NextResponse.json({ error: `type 은 ${VIEW_TYPES.join("/")} 중 하나여야 합니다.` }, { status: 400 });
  }

  const last = await prisma.dbView.findFirst({
    where: { databasePageId: id },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const view = await prisma.dbView.create({
    data: {
      databasePageId: id,
      name,
      type: (body.type as (typeof VIEW_TYPES)[number]) ?? "table",
      config: sanitizeViewConfig(body.config) as object,
      position: (last?.position ?? -1) + 1,
    },
  });
  return NextResponse.json({ view });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { parseEmailList } from "@/lib/sites/access";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const InviteBody = z.object({
  emails: z.unknown().optional(),
});

export const runtime = "nodejs";

/* POST   /api/sites/[id]/invites {emails: string[]} → 허용 이메일 추가
   DELETE /api/sites/[id]/invites {emails: string[]} → 제거 — 셸·/pub 가 매 요청 재판정하므로 즉시 접근이 끊긴다. */

type Params = { params: Promise<{ id: string }> };

type Loaded =
  | { err: NextResponse }
  | { site: { id: string; title: string }; list: { valid: string[]; invalid: string[] } };

// 반환 타입을 명시한다 — 추론에 맡기면 객체 리터럴 유니온에 `err?: undefined` 가 붙어 `"err" in r` 로 좁혀지지 않는다.
async function load(req: Request, id: string, workspaceId: string): Promise<Loaded> {
  const site = await prisma.publishedSite.findFirst({ where: { id, workspaceId, deletedAt: null }, select: { id: true, title: true } });
  if (!site) return { err: NextResponse.json({ error: "사이트를 찾을 수 없습니다." }, { status: 404 }) };
  const parsed = await readBody(req, InviteBody);
  if (!parsed.ok) return { err: parsed.res };
  const body = parsed.data;
  if (!Array.isArray(body.emails)) return { err: NextResponse.json({ error: "emails 배열이 필요합니다." }, { status: 400 }) };
  return { site, list: parseEmailList(body.emails.map(String)) };
}

export async function POST(req: Request, { params }: Params) {
  const ctx = await requireCtx("editor");
  if ("err" in ctx) return ctx.err;
  const r = await load(req, (await params).id, ctx.workspaceId);
  if ("err" in r) return r.err;
  if (r.list.valid.length) {
    await prisma.siteInvite.createMany({
      data: r.list.valid.map((email) => ({ siteId: r.site.id, email, createdById: ctx.userId })),
      skipDuplicates: true,
    });
    recordActivity(ctx, `초대함(${r.list.valid.join(", ")})`, "site", r.site.title, r.site.id);
  }
  return NextResponse.json({ added: r.list.valid, invalid: r.list.invalid });
}

export async function DELETE(req: Request, { params }: Params) {
  const ctx = await requireCtx("editor");
  if ("err" in ctx) return ctx.err;
  const r = await load(req, (await params).id, ctx.workspaceId);
  if ("err" in r) return r.err;
  const { count } = await prisma.siteInvite.deleteMany({ where: { siteId: r.site.id, email: { in: r.list.valid } } });
  if (count) recordActivity(ctx, `초대 회수함(${r.list.valid.join(", ")})`, "site", r.site.title, r.site.id);
  return NextResponse.json({ removed: count });
}

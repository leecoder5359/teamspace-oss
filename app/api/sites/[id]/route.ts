import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { siteUrl } from "@/lib/sites/url";
import { parseApiUpstreamInput } from "@/lib/sites/apiProxy";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const SitePatchBody = z.object({
  title: z.unknown().optional(),
  status: z.unknown().optional(),
  currentVersion: z.unknown().optional(),
  projectId: z.unknown().optional(),
  apiUpstream: z.unknown().optional(),
});

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };
const notFound = () => NextResponse.json({ error: "사이트를 찾을 수 없습니다." }, { status: 404 });

export async function GET(req: Request, { params }: Params) {
  const ctx = await requireCtx("viewer");
  if ("err" in ctx) return ctx.err;
  const { id } = await params;
  const site = await prisma.publishedSite.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    select: {
      id: true, slug: true, title: true, status: true, currentVersion: true, projectId: true, apiUpstream: true, createdAt: true, updatedAt: true,
      versions: { orderBy: { version: "desc" }, select: { version: true, fileCount: true, sizeBytes: true, createdAt: true } },
      invites: { orderBy: { createdAt: "asc" }, select: { email: true, createdAt: true, lastAccessAt: true } },
    },
  });
  if (!site) return notFound();
  const { versions, invites, ...rest } = site;
  return NextResponse.json({ site: rest, url: siteUrl(req, site.slug), versions, invites });
}

export async function PATCH(req: Request, { params }: Params) {
  const ctx = await requireCtx("editor");
  if ("err" in ctx) return ctx.err;
  const { id } = await params;
  const site = await prisma.publishedSite.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, title: true, status: true, currentVersion: true, apiUpstream: true } });
  if (!site) return notFound();

  const parsed = await readBody(req, SitePatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const data: { title?: string; status?: "active" | "disabled"; currentVersion?: number; projectId?: string | null; apiUpstream?: string | null } = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) return NextResponse.json({ error: "title 은 비어 있지 않은 문자열이어야 합니다." }, { status: 400 });
    data.title = body.title.trim().slice(0, 200);
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") return NextResponse.json({ error: "status 는 active|disabled 입니다." }, { status: 400 });
    data.status = body.status;
  }
  if (body.currentVersion !== undefined) {
    const v = Number(body.currentVersion);
    const exists = Number.isInteger(v) && (await prisma.siteVersion.findUnique({ where: { siteId_version: { siteId: id, version: v } }, select: { id: true } }));
    if (!exists) return NextResponse.json({ error: `없는 버전입니다: ${String(body.currentVersion)}` }, { status: 400 });
    data.currentVersion = v;
  }
  if (body.projectId !== undefined) {
    const pid = typeof body.projectId === "string" && body.projectId ? body.projectId : null;
    if (pid && !(await prisma.project.findFirst({ where: { id: pid, workspaceId: ctx.workspaceId }, select: { id: true } }))) {
      return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
    }
    data.projectId = pid;
  }
  // 페이지의 상대경로 fetch('api/..') 를 넘길 로컬 서버. 루프백만(SSRF 방지) — /pub/[token]/[...path]/route.ts.
  // 권한은 editor 그대로: 프록시는 인증 헤더를 넘기지 않으므로 앱 자신(루프백 포트)을 가리켜도 401 이고,
  // AUTH_OPEN_API=true 인 배포는 /api 가 이미 공개라 프록시가 새로 여는 것이 없다.
  if (body.apiUpstream !== undefined) {
    const up = parseApiUpstreamInput(body.apiUpstream);
    if (!up.ok) return NextResponse.json({ error: up.error }, { status: 400 });
    data.apiUpstream = up.value;
  }

  const updated = await prisma.publishedSite.update({
    where: { id },
    data,
    select: { id: true, slug: true, title: true, status: true, currentVersion: true, projectId: true, apiUpstream: true },
  });
  if (data.status && data.status !== site.status) recordActivity(ctx, data.status === "disabled" ? "비활성화함" : "활성화함", "site", updated.title, id);
  if (data.currentVersion && data.currentVersion !== site.currentVersion) recordActivity(ctx, `v${data.currentVersion}로 롤백함`, "site", updated.title, id);
  // 게스트가 로컬 서버를 호출할 수 있게 되는 변경이라 기록한다(주소는 활동 로그에 싣지 않는다).
  if (data.apiUpstream !== undefined && data.apiUpstream !== site.apiUpstream) recordActivity(ctx, data.apiUpstream ? "API 프록시를 연결함" : "API 프록시를 해제함", "site", updated.title, id);
  return NextResponse.json({ site: updated });
}

export async function DELETE(_req: Request, { params }: Params) {
  const ctx = await requireCtx("editor");
  if ("err" in ctx) return ctx.err;
  const { id } = await params;
  const site = await prisma.publishedSite.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, title: true } });
  if (!site) return notFound();
  await prisma.publishedSite.update({ where: { id }, data: { deletedAt: new Date() } });
  recordActivity(ctx, "삭제함", "site", site.title, id);
  return NextResponse.json({ ok: true });
}

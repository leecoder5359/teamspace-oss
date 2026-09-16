import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { readBundleUpload } from "@/lib/sites/upload";
import { parseEmailList } from "@/lib/sites/access";
import { writeVersion, sitesRoot } from "@/lib/sites/store";
import { siteUrl, newSlug } from "@/lib/sites/url";

export const runtime = "nodejs";

// 트랜잭션 안에서 최대 500개·50MB 를 디스크에 쓴다 — Prisma 기본 5초면 큰 번들이 쓰는 도중 롤백된다.
const SITE_TX_TIMEOUT_MS = 60_000;

/* =====================================================================
   GET  /api/sites → 워크스페이스의 퍼블리시 사이트 목록
   POST /api/sites (multipart file, title?, projectId?, invites?) → 사이트 + v1

   이 경로는 **미들웨어 matcher 밖**이다(10MB 넘는 multipart 가 엣지에서 깨진다 —
   /api/import 와 같은 사유). 그래서 첫 줄 requireCtx 가 유일한 게이트다.
   ===================================================================== */

export async function GET(req: Request) {
  const ctx = await requireCtx("viewer");
  if ("err" in ctx) return ctx.err;
  const rows = await prisma.publishedSite.findMany({
    where: { workspaceId: ctx.workspaceId, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, slug: true, title: true, status: true, currentVersion: true, projectId: true, apiUpstream: true, updatedAt: true,
      invites: { select: { lastAccessAt: true } },
    },
  });
  const sites = rows.map(({ invites, ...s }) => {
    const seen = invites.map((i) => i.lastAccessAt?.getTime() ?? 0).filter(Boolean);
    return {
      ...s,
      inviteCount: invites.length,
      lastAccessAt: seen.length ? new Date(Math.max(...seen)).toISOString() : null,
      url: siteUrl(req, s.slug),
    };
  });
  return NextResponse.json({ sites });
}

export async function POST(req: Request) {
  const ctx = await requireCtx("editor");
  if ("err" in ctx) return ctx.err;

  const up = await readBundleUpload(req);
  if (!up.ok) return up.res;

  const rawTitle = String(up.form.get("title") ?? "").trim();
  const title = (rawTitle || up.filename.replace(/\.(html?|zip)$/i, "")).slice(0, 200);
  const projectId = String(up.form.get("projectId") ?? "").trim() || null;
  if (projectId) {
    const p = await prisma.project.findFirst({ where: { id: projectId, workspaceId: ctx.workspaceId }, select: { id: true } });
    if (!p) return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
  }
  const invites = parseEmailList(String(up.form.get("invites") ?? ""));

  // 파일 쓰기를 트랜잭션 안에서 한다: 쓰기가 실패하면 행이 롤백된다.
  // (커밋이 쓰기 뒤에 실패하면 고아 폴더가 남는데, 서빙 경로가 DB 를 먼저 보므로 노출되지 않는다.)
  const site = await prisma.$transaction(async (tx) => {
    const created = await tx.publishedSite.create({
      data: { workspaceId: ctx.workspaceId, projectId, slug: newSlug(), title, createdById: ctx.userId },
      select: { id: true, slug: true, title: true, status: true, currentVersion: true },
    });
    await tx.siteVersion.create({
      data: { siteId: created.id, version: 1, fileCount: up.files.length, sizeBytes: up.sizeBytes, createdById: ctx.userId },
    });
    if (invites.valid.length) {
      await tx.siteInvite.createMany({
        data: invites.valid.map((email) => ({ siteId: created.id, email, createdById: ctx.userId })),
        skipDuplicates: true,
      });
    }
    await writeVersion(sitesRoot(), created.id, 1, up.files);
    return created;
  }, { timeout: SITE_TX_TIMEOUT_MS });

  recordActivity(ctx, "퍼블리시함", "site", site.title, site.id);
  return NextResponse.json(
    { site, url: siteUrl(req, site.slug), invites: { added: invites.valid, invalid: invites.invalid }, skipped: up.skipped, warnings: up.warnings },
    { status: 201 },
  );
}

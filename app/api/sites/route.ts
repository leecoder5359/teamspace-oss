import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { readBundleUpload } from "@/lib/sites/upload";
import { parseEmailList } from "@/lib/sites/access";
import { writeVersion, sitesRoot } from "@/lib/sites/store";
import { siteUrl, newSlug } from "@/lib/sites/url";
import { checkSlug, lockSiteSlugs, slugTaken, slugTakenError, isUniqueViolation } from "@/lib/sites/slug";

export const runtime = "nodejs";

// 트랜잭션 안에서 최대 500개·50MB 를 디스크에 쓴다 — Prisma 기본 5초면 큰 번들이 쓰는 도중 롤백된다.
const SITE_TX_TIMEOUT_MS = 60_000;

/* =====================================================================
   GET  /api/sites → 워크스페이스의 퍼블리시 사이트 목록
   POST /api/sites (multipart file, title?, projectId?, invites?, slug?) → 사이트 + v1
     slug: 설명형 주소(lib/sites/slug 규칙, 형식 틀리면 400·이미 쓰는 주소면 409). 없으면 무작위.

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
      aliases: { orderBy: { createdAt: "desc" }, select: { slug: true } },
    },
  });
  const sites = rows.map(({ invites, aliases, ...s }) => {
    const seen = invites.map((i) => i.lastAccessAt?.getTime() ?? 0).filter(Boolean);
    return {
      ...s,
      aliases: aliases.map((a) => a.slug),
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
  const rawSlug = String(up.form.get("slug") ?? "").trim();
  let slug = newSlug();
  if (rawSlug) {
    const c = checkSlug(rawSlug);
    if (!c.ok) return NextResponse.json({ error: c.error }, { status: 400 });
    if (await slugTaken(prisma, c.slug)) return NextResponse.json({ error: slugTakenError(c.slug) }, { status: 409 });
    slug = c.slug;
  }

  // 파일 쓰기를 트랜잭션 안에서 한다: 쓰기가 실패하면 행이 롤백된다.
  // (커밋이 쓰기 뒤에 실패하면 고아 폴더가 남는데, 서빙 경로가 DB 를 먼저 보므로 노출되지 않는다.)
  const { workspaceId, userId } = ctx;
  let site;
  try {
    site = await prisma.$transaction(async (tx) => {
      // 지정 슬러그: 락을 잡고 다시 검사한다 — 위 검사는 빠른 거절용이고, 별칭 테이블과의
      // 교차 유일성은 이 락 안의 재검사가 보장한다(lib/sites/slug lockSiteSlugs).
      if (rawSlug) {
        await lockSiteSlugs(tx);
        if (await slugTaken(tx, slug)) throw new SlugTaken();
      }
      const created = await tx.publishedSite.create({
        data: { workspaceId, projectId, slug, title, createdById: userId },
        select: { id: true, slug: true, title: true, status: true, currentVersion: true },
      });
      await tx.siteVersion.create({
        data: { siteId: created.id, version: 1, fileCount: up.files.length, sizeBytes: up.sizeBytes, createdById: userId },
      });
      if (invites.valid.length) {
        await tx.siteInvite.createMany({
          data: invites.valid.map((email) => ({ siteId: created.id, email, createdById: userId })),
          skipDuplicates: true,
        });
      }
      await writeVersion(sitesRoot(), created.id, 1, up.files);
      return created;
    }, { timeout: SITE_TX_TIMEOUT_MS });
  } catch (e) {
    // 검사와 생성 사이에 다른 요청이 같은 주소를 잡은 경우.
    if (rawSlug && (e instanceof SlugTaken || isUniqueViolation(e))) return NextResponse.json({ error: slugTakenError(slug) }, { status: 409 });
    throw e;
  }

  recordActivity(ctx, "퍼블리시함", "site", site.title, site.id);
  return NextResponse.json(
    { site, url: siteUrl(req, site.slug), invites: { added: invites.valid, invalid: invites.invalid }, skipped: up.skipped, warnings: up.warnings },
    { status: 201 },
  );
}

class SlugTaken extends Error {}

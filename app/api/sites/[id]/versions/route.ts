import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { readBundleUpload } from "@/lib/sites/upload";
import { SITE_LIMITS } from "@/lib/sites/bundle";
import { writeVersion, removeVersionDir, sitesRoot, versionsToPrune } from "@/lib/sites/store";

export const runtime = "nodejs";

// 트랜잭션 안에서 최대 500개·50MB 를 디스크에 쓴다 — Prisma 기본 5초면 큰 번들이 쓰는 도중 롤백된다.
const SITE_TX_TIMEOUT_MS = 60_000;

/* POST /api/sites/[id]/versions (multipart file) → v(n+1) 을 만들고 current 로 지정.
   오래된 버전은 최근 SITE_LIMITS.keepVersions 개만 남기고 정리한다(current 제외). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("editor");
  if ("err" in ctx) return ctx.err;
  const { id } = await params;
  const site = await prisma.publishedSite.findFirst({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, title: true } });
  if (!site) return NextResponse.json({ error: "사이트를 찾을 수 없습니다." }, { status: 404 });

  const up = await readBundleUpload(req);
  if (!up.ok) return up.res;

  const version = await prisma.$transaction(async (tx) => {
    const last = await tx.siteVersion.findFirst({ where: { siteId: id }, orderBy: { version: "desc" }, select: { version: true } });
    const next = (last?.version ?? 0) + 1;
    await tx.siteVersion.create({ data: { siteId: id, version: next, fileCount: up.files.length, sizeBytes: up.sizeBytes, createdById: ctx.userId } });
    await tx.publishedSite.update({ where: { id }, data: { currentVersion: next } });
    await writeVersion(sitesRoot(), id, next, up.files);
    return next;
  }, { timeout: SITE_TX_TIMEOUT_MS });

  const all = await prisma.siteVersion.findMany({ where: { siteId: id }, select: { version: true } });
  const pruned = versionsToPrune(all.map((v) => v.version), version, SITE_LIMITS.keepVersions);
  if (pruned.length) {
    await prisma.siteVersion.deleteMany({ where: { siteId: id, version: { in: pruned } } });
    await Promise.all(pruned.map((v) => removeVersionDir(sitesRoot(), id, v).catch(() => undefined)));
  }

  recordActivity(ctx, `v${version} 올림`, "site", site.title, id);
  return NextResponse.json({ version, skipped: up.skipped, warnings: up.warnings, pruned }, { status: 201 });
}

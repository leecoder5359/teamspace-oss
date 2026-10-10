import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { loadAccess, pageAccess, projectAccess } from "@/lib/pageGuard";
import { channelCanSee, collectDigest, excludeArchived, digestItemCount, renderDigest, renderDigestMarkdown, weekRange } from "@/lib/digest";
import { fireNotif } from "@/lib/notify";

export const runtime = "nodejs";

const DAY_MS = 86_400_000;
const Days = z.coerce.number().int().min(1).max(31).default(7);
const Week = z.enum(["1", "true"]).optional();
const notFound = () => NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });

/** 기간: week 면 지난주(Asia/Seoul 월 00:00 ~ 월 00:00 — 워커와 같은 창), 아니면 지금부터 거꾸로 days 일(롤링). */
function period(week: boolean, days: number): { since: Date; until: Date } {
  const now = new Date();
  return week ? weekRange(now) : { since: new Date(now.getTime() - days * DAY_MS), until: now };
}

/**
 * GET /api/digest?project=<id>&days=7 | &week=1 (editor 이상) → { digest, markdown }
 *   지난 days 일(1..31, 롤링) 또는 지난주(week=1, Asia/Seoul 월~일) 동안 프로젝트의 완료 태스크·결정·레슨·문서·승인 요약.
 *   보드·문서는 요청자가 볼 수 있는 것만(D3), 볼 수 없는 프로젝트는 404.
 * POST /api/digest { projectId, days? | week?: true, send: true } (admin) → { sent, channels?, error?, reason? }
 *   fireNotif("weekly_digest") 로 지금 1회 발송 — 그 프로젝트 규칙 → 전역 규칙 → 규칙이 없으면 Slack 기본 채널.
 *   채널은 누가 읽을지 모르므로 잠긴 프로젝트는 409, 잠긴 보드·문서는 내용에서 뺀다.
 *   활동이 0건이면 보내지 않는다(reason:"empty"). 워커의 주간 중복 방지 마커는 남기지 않는다(수동 발송은 별개).
 */
export async function GET(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("project")?.trim();
  if (!projectId) return NextResponse.json({ error: "project 가 필요합니다." }, { status: 400 });
  const days = Days.safeParse(url.searchParams.get("days") ?? undefined);
  if (!days.success) return NextResponse.json({ error: "days 는 1~31 정수여야 합니다." }, { status: 400 });
  const week = Week.safeParse(url.searchParams.get("week") ?? undefined);
  if (!week.success) return NextResponse.json({ error: "week 는 1 또는 true 여야 합니다." }, { status: 400 });

  const idx = await loadAccess(guard);
  if (projectAccess(idx, projectId) === "none") return notFound();
  const digest = await collectDigest(prisma, {
    workspaceId: guard.workspaceId,
    projectId,
    ...period(week.data !== undefined, days.data),
    // 보관된 조상 아래 보드·문서는 빼고(F2) 요청자가 볼 수 있는 것만
    canSee: await excludeArchived(guard.workspaceId, (id) => pageAccess(idx, id) !== "none"),
  });
  if (!digest) return notFound();
  return NextResponse.json({ digest, markdown: renderDigestMarkdown(digest) });
}

const Body = z.object({ projectId: z.string().min(1), days: Days, week: z.boolean().optional(), send: z.literal(true) });

export async function POST(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "projectId 와 send:true 가 필요합니다(days 1~31)." }, { status: 400 });
  const { projectId, days, week } = parsed.data;

  const project = await prisma.project.findFirst({ where: { id: projectId, workspaceId: guard.workspaceId }, select: { visibility: true } });
  if (!project) return notFound();
  if (project.visibility === "restricted") {
    return NextResponse.json({ error: "제한된 프로젝트는 채널로 보내지 않습니다(누가 읽을지 모름)." }, { status: 409 });
  }
  const digest = await collectDigest(prisma, {
    workspaceId: guard.workspaceId,
    projectId,
    ...period(week === true, days),
    canSee: await channelCanSee(guard.workspaceId),
  });
  if (!digest) return notFound();
  if (digestItemCount(digest) === 0) return NextResponse.json({ sent: false, reason: "empty" });
  const r = await fireNotif(guard.workspaceId, "weekly_digest", renderDigest(digest), projectId, { kind: "digest", fallbackToDefault: true });
  const ok = r.delivered > 0 && r.failed === 0;
  // 일부 채널만 실패해도 sent:false(error 에 첫 사유) — channels 는 실제로 간 채널 수
  return NextResponse.json(ok ? { sent: true, channels: r.delivered } : { sent: false, channels: r.delivered, error: r.error ?? (r.noTarget ? "no_channel" : "post_failed") });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { isBootstrapCtx } from "@/lib/bootstrapCtx";
import { intakeKeyError } from "@/lib/sites/intakeCrypto";

export const runtime = "nodejs";

/* GET /api/sites/[id]/intake → { entries: [...], keyMissing } — 게스트가 보낸 계정 정보 **목록**.
   값은 여기서 절대 풀지 않는다(암호문도 내보내지 않는다). 복호화는 건별 조회
   `GET /api/sites/[id]/intake/[entryId]` 에서만, 열람 기록을 남기며 한다.
   메타데이터도 "누가 무엇을 맡겼는지" 라서 AUTH_OPEN_API=true 부트스트랩 ctx 는 거절한다. */

const MAX_ROWS = 500;
const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("viewer");
  if ("err" in ctx) return ctx.err;
  if (isBootstrapCtx(ctx)) {
    return NextResponse.json(
      { error: "AUTH_OPEN_API=true 인 서버에서는 계정 정보를 볼 수 없습니다. 로그인 세션이나 에이전트 토큰으로 접근하세요." },
      { status: 403, headers: NO_STORE },
    );
  }
  const { id } = await params;
  const site = await prisma.publishedSite.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    select: { id: true },
  });
  if (!site) return NextResponse.json({ error: "사이트를 찾을 수 없습니다." }, { status: 404 });

  const entries = await prisma.siteIntakeEntry.findMany({
    where: { siteId: id },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: {
      id: true, service: true, fieldCount: true, submittedBy: true, submittedByMember: true,
      createdAt: true, revealCount: true, lastRevealedAt: true,
    },
  });
  return NextResponse.json({ entries, keyMissing: Boolean(intakeKeyError()) }, { headers: NO_STORE });
}

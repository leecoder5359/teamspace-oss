import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { pairingState, claimFailure, isPairingCode, PAIRING_TTL_MS } from "@/lib/pairing";

export const runtime = "nodejs";

// 페어링 응답의 base 필드 — 설치기가 이 값을 teamspace.json 에 적는다.
// 하드코딩 폴백은 이 배포의 tailscale 호스트다. 다른 곳에 세우면 PUBLIC_BASE_URL 을
// 반드시 설정해야 한다(안 하면 새 기기가 남의 서버를 가리킨다).
const BASE = process.env.PUBLIC_BASE_URL ?? "https://teamspace.example.com";

/* GET /api/pair/<code> — CLI 폴링. 승인 전 202, 승인 후 토큰 **1회** 전달(이후 410).

   "1회" 를 읽고-쓰기로 지키면 안 된다(설치기 후속): findUnique 로 미전달을 확인한
   뒤 update 하는 사이에 다른 폴이 같은 확인을 통과하면 **같은 토큰이 두 번 나간다**.
   그래서 인도는 조건부 update 한 방(`tokenDeliveredAt IS NULL` + 만료 안 됨 + 같은
   토큰)으로 하고, **1행을 고쳤을 때만** 토큰을 준다 — 경합에서 지면 아무도 두 번
   받지 못한다. 실제 CLI 는 순차 폴링이라 지금 위험은 0이지만, '한 번만' 이라는
   보장이 코드에 없으면 나중에 병렬 폴링·재시도가 붙는 날 조용히 깨진다. */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (!isPairingCode(code)) return NextResponse.json({ error: "bad code" }, { status: 400 });
  const row = await prisma.pairing.findUnique({ where: { code } });
  if (!row) {
    return NextResponse.json({ status: "pending" }, { status: 202 });
  }
  const now = new Date();
  const state = pairingState(row, now);
  if (state !== "deliverable") {
    return NextResponse.json({ status: state }, { status: 410 }); // delivered | expired
  }

  const claimed = await prisma.pairing.updateMany({
    where: {
      code,
      tokenDeliveredAt: null,
      token: row.token, // 재승인이 끼어들어 토큰이 갈렸으면 이 인도는 무효다
      createdAt: { gt: new Date(now.getTime() - PAIRING_TTL_MS) },
    },
    data: { tokenDeliveredAt: now },
  });
  if (claimed.count === 1) {
    return NextResponse.json({ token: row.token, base: BASE });
  }

  // 못 잡았다 — 이유를 다시 읽어 판단한다. 재승인 중이면 410 이 아니라 202 로
  // 돌려보내야 한다(CLI 가 다음 폴에서 새 토큰을 받는다).
  const fresh = await prisma.pairing.findUnique({ where: { code } });
  const why = claimFailure(row.token, fresh, now);
  return why === "retry"
    ? NextResponse.json({ status: "pending" }, { status: 202 })
    : NextResponse.json({ status: why }, { status: 410 });
}

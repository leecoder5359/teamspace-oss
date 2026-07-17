import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { pairingState } from "@/lib/pairing";

export const runtime = "nodejs";

const BASE = process.env.PUBLIC_BASE_URL ?? "http://localhost:3002";

// GET /api/pair/<code> — CLI 폴링. 승인 전 202, 승인 후 토큰 1회 전달(이후 410).
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (!/^[0-9a-f]{32}$/.test(code)) return NextResponse.json({ error: "bad code" }, { status: 400 });
  const row = await prisma.pairing.findUnique({ where: { code } });
  if (!row) {
    return NextResponse.json({ status: "pending" }, { status: 202 });
  }
  const state = pairingState(row, new Date());
  if (state === "deliverable") {
    await prisma.pairing.update({ where: { code }, data: { tokenDeliveredAt: new Date() } });
    return NextResponse.json({ token: row.token, base: BASE });
  }
  return NextResponse.json({ status: state }, { status: 410 }); // delivered | expired
}

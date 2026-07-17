import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const WORKER_FRESH_MS = 90_000; // 워커 tick 60초 + 여유

// GET /api/health → 무인증 최소 상태 (W7 missed-6).
// funnel 로 공개되는 엔드포인트라 내부 정보(카운트·이름 등)는 절대 싣지 않는다.
// db 실패 → 503. worker 는 하트비트 신선도(90초)만 boolean 으로.
export async function GET() {
  let db = false;
  let worker = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
    const hb = await prisma.heartbeat.findUnique({ where: { id: "worker" } });
    worker = !!hb && Date.now() - hb.at.getTime() < WORKER_FRESH_MS;
  } catch {
    db = false;
  }
  const ok = db;
  return NextResponse.json({ ok, db, worker }, { status: ok ? 200 : 503 });
}

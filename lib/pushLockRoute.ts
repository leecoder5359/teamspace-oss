import { NextResponse } from "next/server";
import { LockError } from "@/lib/pushLock";
import { log } from "@/lib/log";

/** 잠금 라우트 공통 오류 응답 — LockError 는 상태·부가 정보 그대로, 나머지는 500. */
export function lockErrorResponse(e: unknown): NextResponse {
  if (e instanceof LockError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status });
  log.error("locks.failed", { msg: "잠금 처리 중 예기치 못한 오류", err: e });
  return NextResponse.json({ error: "잠금 처리 중 오류가 났습니다." }, { status: 500 });
}

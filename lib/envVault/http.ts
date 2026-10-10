import { NextResponse } from "next/server";
import type { Ctx, CtxResult } from "@/lib/workspace";
import { vaultEnabled } from "./crypto";
import { EnvVaultError, type Meta } from "./service";

/* env 금고 라우트 공통 — 비활성(503)·권한·감사 메타·에러 변환. */

export const DISABLED_MSG = "env 금고가 꺼져 있습니다(ENV_VAULT_KEY).";

/** 값이 실린 응답은 어디에도 캐시되지 않게 한다. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * 권한 모드
 * - "read":   viewer 이상(값 없음)
 * - "editor": editor 이상(사람·에이전트)
 * - "admin":  admin(사람·에이전트)
 * - "human-admin": admin **로그인 세션**만 — 에이전트 토큰 거부(CLI 는 항상 에이전트 토큰)
 * - "pull":   admin 로그인 세션 또는 editor 이상 에이전트
 * - "target": pull 과 같은 하한(사람 세션은 admin, 에이전트는 editor 이상) — push 대상 관리·push 요청.
 *             값이 실제로 나가는 관문은 사람의 고위험 승인 클릭이라 에이전트에 admin 토큰을 요구하지 않는다.
 */
export type Guard = "read" | "editor" | "admin" | "human-admin" | "pull" | "target";

/**
 * requireCtx 결과에 env 금고 규칙을 덧씌운다. 라우트는 `requireCtx(...)` 를 직접 부른 결과를 넘긴다
 * (scripts/authz-coverage.test.ts 가 라우트 소스에 requireCtx 호출이 있는지 정적으로 본다).
 * 역할 하한: read=viewer · editor/pull/target=editor · admin/human-admin=admin.
 */
export function envGuard(g: CtxResult, mode: Guard): { ctx: Ctx } | { err: NextResponse } {
  if ("err" in g) return { err: g.err };
  if (mode === "human-admin" && g.actor.type !== "user") {
    return { err: NextResponse.json({ error: "값 설정·열람은 관리자 로그인 세션에서만 할 수 있습니다(에이전트 토큰 불가)." }, { status: 403 }) };
  }
  if (mode === "pull" && g.actor.type === "user" && g.role !== "admin") {
    return { err: NextResponse.json({ error: "값 내려받기는 관리자만 할 수 있습니다." }, { status: 403 }) };
  }
  if (mode === "target" && g.actor.type === "user" && g.role !== "admin") {
    return { err: NextResponse.json({ error: "반영 대상 관리·반영 요청은 관리자만 할 수 있습니다." }, { status: 403 }) };
  }
  if (!vaultEnabled()) return { err: NextResponse.json({ error: DISABLED_MSG }, { status: 503 }) };
  return { ctx: g };
}

/** Tailscale Funnel(공개 입구)을 거친 요청이면 감사 로그에 표시한다(차단은 하지 않음 — 확정 결정 2). */
export function metaOf(req: Request): Meta {
  return { viaFunnel: req.headers.has("Tailscale-Funnel-Request") };
}

/** 서비스 에러 → 응답. 알 수 없는 에러는 메시지를 숨긴다(값이 섞일 여지를 없앤다). */
export function envError(e: unknown, where: string): NextResponse {
  if (e instanceof EnvVaultError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(`[env ${where}] 처리 실패`, e instanceof Error ? e.name : typeof e);
  return NextResponse.json({ error: "env 금고 처리에 실패했습니다." }, { status: 500 });
}

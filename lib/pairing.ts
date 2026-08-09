import { randomBytes } from "node:crypto";

/**
 * 새 머신 curl|sh 페어링 코드 상태 로직 (W1).
 * TTL 10분: 코드 생성 후 이 시간 안에 토큰을 회수해야 한다.
 */

export const PAIRING_TTL_MS = 600_000; // 10분

export interface PairingRow {
  code: string;
  token: string;
  userId: string;
  workspaceId: string;
  createdAt: Date;
  tokenDeliveredAt: Date | null;
}

export type PairingState = "pending" | "deliverable" | "expired" | "delivered";

/**
 * 페어링 코드의 **모양** — 32자리 소문자 hex.
 *
 * 코드를 실제로 만드는 곳은 서버가 아니라 설치기(`scripts/setup/setup.sh` 의
 * `od -An -N16 -tx1 /dev/urandom`)다. 그래서 이 정규식이 계약이고, 라우트들은
 * 각자 인라인 정규식을 쓰지 않고 여기서 가져다 쓴다 — 같은 계약이 세 군데
 * 흩어져 있으면 한 곳만 고쳐지는 날이 온다.
 */
export const PAIRING_CODE_RE = /^[0-9a-f]{32}$/;

export function isPairingCode(v: unknown): v is string {
  return typeof v === "string" && PAIRING_CODE_RE.test(v);
}

/**
 * 서버 측 생성기. 지금 이 서버는 코드를 만들지 않지만(클라가 만든다) **계약의
 * 기준점**으로 남겨 둔다 — 테스트가 이 함수의 출력과 `PAIRING_CODE_RE`·설치기의
 * `-N16` 을 한 줄에 묶어 검증하므로, 셋 중 하나만 바뀌면 빨간불이 난다.
 */
export function newPairingCode(): string {
  return randomBytes(16).toString("hex");
}

export function pairingState(row: PairingRow, now: Date): PairingState {
  if (now.getTime() - row.createdAt.getTime() > PAIRING_TTL_MS) return "expired";
  if (row.tokenDeliveredAt) return "delivered";
  return "deliverable";
}

/**
 * 토큰 인도(claim)에 실패했을 때 뭐라고 답할지. 조건부 update 가 0행을 고쳤다는
 * 것은 "내가 읽은 그 행이 이제 그 상태가 아니다" 는 뜻이고, 이유가 셋이라
 * 응답이 달라야 한다:
 *
 *   - 재승인이 끼어들어 토큰이 바뀌었다 → **retry**. CLI 는 폴링 중이니 다음
 *     폴에서 새 토큰을 받으면 된다. 여기서 410 을 주면 설치가 헛되게 죽는다.
 *   - 다른 폴이 먼저 받아갔다 → delivered(410). 토큰은 한 번만 나간다.
 *   - TTL 이 지났다 → expired(410).
 */
export function claimFailure(
  prevToken: string,
  fresh: PairingRow | null,
  now: Date,
): "retry" | "delivered" | "expired" {
  if (!fresh) return "retry"; // 행이 사라졌다(승인 취소·정리) — 다시 폴링하게 둔다
  if (fresh.token !== prevToken) return "retry"; // 재승인으로 갈렸다
  const state = pairingState(fresh, now);
  if (state === "expired") return "expired";
  if (state === "delivered") return "delivered";
  return "retry"; // 여전히 deliverable 인데 못 잡았다 — 다음 폴에 맡긴다
}

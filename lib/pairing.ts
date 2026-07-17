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

export function newPairingCode(): string {
  return randomBytes(16).toString("hex");
}

export function pairingState(row: PairingRow, now: Date): PairingState {
  if (now.getTime() - row.createdAt.getTime() > PAIRING_TTL_MS) return "expired";
  if (row.tokenDeliveredAt) return "delivered";
  return "deliverable";
}

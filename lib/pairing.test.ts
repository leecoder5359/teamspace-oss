import { describe, it, expect } from "vitest";
import { pairingState, newPairingCode, PAIRING_TTL_MS } from "./pairing";

const base = { code: "x", token: "wst_x", userId: "u", workspaceId: "w", tokenDeliveredAt: null as Date | null };

describe("pairingState", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const fresh = new Date(now.getTime() - 1000);
  const old = new Date(now.getTime() - PAIRING_TTL_MS - 1000);
  it("미전달·미만료 → deliverable", () => {
    expect(pairingState({ ...base, createdAt: fresh }, now)).toBe("deliverable");
  });
  it("전달됨 → delivered", () => {
    expect(pairingState({ ...base, createdAt: fresh, tokenDeliveredAt: fresh }, now)).toBe("delivered");
  });
  it("만료 → expired (전달 여부 무관)", () => {
    expect(pairingState({ ...base, createdAt: old }, now)).toBe("expired");
  });
});
describe("newPairingCode", () => {
  it("32 hex, 매번 다름", () => {
    const a = newPairingCode(); const b = newPairingCode();
    expect(a).toMatch(/^[0-9a-f]{32}$/); expect(a).not.toBe(b);
  });
});

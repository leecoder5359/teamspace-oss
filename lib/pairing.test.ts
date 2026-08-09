import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { pairingState, newPairingCode, claimFailure, isPairingCode, PAIRING_CODE_RE, PAIRING_TTL_MS } from "./pairing";

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

  // 코드를 만드는 곳은 설치기(od -N16 = 16바이트 = 32 hex)다. 서버 생성기·정규식·설치기
  // 셋이 같은 계약을 봐야 하므로 여기서 묶어 둔다 — 하나만 바뀌면 빨간불.
  it("생성기 출력이 PAIRING_CODE_RE 를 만족한다(계약 한 줄로 묶기)", () => {
    expect(PAIRING_CODE_RE.test(newPairingCode())).toBe(true);
    expect(newPairingCode()).toHaveLength(32);
  });
});

describe("isPairingCode", () => {
  it("32 소문자 hex 만 통과", () => {
    expect(isPairingCode("a".repeat(32))).toBe(true);
    expect(isPairingCode("A".repeat(32))).toBe(false); // 대문자 hex 는 설치기가 만들지 않는다
    expect(isPairingCode("a".repeat(31))).toBe(false);
    expect(isPairingCode("a".repeat(33))).toBe(false);
    expect(isPairingCode("")).toBe(false);
    expect(isPairingCode(undefined)).toBe(false);
    expect(isPairingCode(123)).toBe(false);
  });
});

describe("claimFailure — 조건부 update 가 0행일 때 무엇을 답할지", () => {
  const now = new Date("2026-08-09T00:00:00Z");
  const fresh = new Date(now.getTime() - 1000);
  const old = new Date(now.getTime() - PAIRING_TTL_MS - 1000);

  it("다른 폴이 먼저 받아갔으면 delivered", () => {
    expect(claimFailure("wst_x", { ...base, token: "wst_x", createdAt: fresh, tokenDeliveredAt: fresh }, now)).toBe("delivered");
  });

  it("TTL 이 지났으면 expired", () => {
    expect(claimFailure("wst_x", { ...base, token: "wst_x", createdAt: old }, now)).toBe("expired");
  });

  it("재승인으로 토큰이 갈렸으면 retry — 설치를 죽이지 않는다", () => {
    expect(claimFailure("wst_old", { ...base, token: "wst_new", createdAt: fresh }, now)).toBe("retry");
  });

  it("행이 사라졌으면 retry", () => {
    expect(claimFailure("wst_x", null, now)).toBe("retry");
  });

  it("여전히 deliverable 인데 못 잡았으면 retry", () => {
    expect(claimFailure("wst_x", { ...base, token: "wst_x", createdAt: fresh }, now)).toBe("retry");
  });
});

/* 페어링 코드 계약(32 hex)이 라우트마다 인라인 정규식으로 흩어져 있던 것이 원래
   문제였다(설치기 후속: 서버 생성기는 데드코드, 계약은 od·정규식 2곳에 분산).
   이제 lib/pairing 이 유일한 출처이므로, 페어링 관련 파일에 정규식이 다시
   복사되면 이 테스트가 잡는다. */
describe("페어링 코드 계약은 lib/pairing 한 곳에만 있다", () => {
  const roots = [join(__dirname, "..", "app", "api", "pair"), join(__dirname, "..", "app", "setup", "pair")];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) files.push(full);
    }
  };
  roots.forEach(walk);

  it("스캐너가 파일을 찾는다(자체 검증)", () => {
    expect(files.length).toBeGreaterThan(3);
  });

  for (const f of files) {
    it(`${f.split("/").slice(-3).join("/")} 는 코드 정규식을 인라인하지 않는다`, () => {
      const src = readFileSync(f, "utf8");
      expect(
        src.includes("[0-9a-f]{32}"),
        `${f} 에 32hex 정규식이 다시 들어왔습니다 — lib/pairing 의 isPairingCode/PAIRING_CODE_RE 를 쓰세요.`,
      ).toBe(false);
    });
  }
});

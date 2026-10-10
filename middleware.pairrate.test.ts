import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/* 페어링 폴링 한도: 코드별 60/분 + IP 합산 240/분. IP 합산에서 거절되는 요청은 코드별 버킷을 소모하지 않는다. */
vi.mock("next-auth", () => ({ default: () => ({ auth: (fn: unknown) => fn }) }));
vi.mock("@/auth.config", () => ({ authConfig: {} }));

type Handler = (req: NextRequest & { auth: unknown }) => Response | undefined;
let middleware: Handler;

const code = (n: number) => n.toString(16).padStart(32, "0");
const status = (c: string): number => {
  const req = new NextRequest(`http://localhost/api/pair/${c}`, { headers: { "x-forwarded-for": "9.9.9.9" } }) as NextRequest & { auth: unknown };
  req.auth = null;
  return middleware(req)!.status;
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("RATE_LIMIT", "");
  vi.stubEnv("AUTH_OPEN_API", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
  middleware = (await import("./middleware")).default as unknown as Handler;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("pair 폴링 레이트 리밋 순서", () => {
  it("IP 합산이 거절한 요청은 코드별 버킷을 소모하지 않는다", async () => {
    // 코드 1~5 가 48회씩 = 240회로 IP 합산을 소진한다(코드별 60 미만)
    for (let c = 1; c <= 5; c++) for (let i = 0; i < 48; i++) expect(status(code(c))).not.toBe(429);
    // 새 코드 X 를 60번 더 두드려도 전부 IP 합산에서 거절된다
    for (let i = 0; i < 60; i++) expect(status(code(99))).toBe(429);
    // 2초 뒤: IP 는 8토큰 리필(240/60s). 코드 X 가 소모되지 않았다면 8번 모두 통과한다
    vi.setSystemTime(new Date("2026-10-09T00:00:02Z"));
    const results = Array.from({ length: 8 }, () => status(code(99)));
    expect(results.every((s) => s !== 429)).toBe(true);
    expect(status(code(99))).toBe(429); // 9번째는 IP 합산 소진
  });

  it("한 코드가 60/분을 넘기면 그 코드만 막힌다", () => {
    for (let i = 0; i < 60; i++) expect(status(code(1))).not.toBe(429);
    expect(status(code(1))).toBe(429);
    expect(status(code(2))).not.toBe(429);
  });
});

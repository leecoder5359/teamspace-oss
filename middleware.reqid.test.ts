import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/*
 * middleware 의 x-request-id 전파. next-auth 래퍼는 세션 해석(쿠키·JWT)을 하므로 여기서는
 * 사용자 콜백을 그대로 돌려주는 가짜로 바꾸고, req.auth 를 직접 붙여 모든 응답 경로를 본다.
 * (실제 래퍼는 사용자 응답을 new Response(body, response) 로 복사하므로 헤더가 그대로 이어진다.)
 */
vi.mock("next-auth", () => ({ default: () => ({ auth: (fn: unknown) => fn }) }));
vi.mock("@/auth.config", () => ({ authConfig: {} }));

type Handler = (req: NextRequest & { auth: unknown }) => Response | undefined;
let middleware: Handler;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function call(path: string, opts: { auth?: unknown; headers?: Record<string, string>; method?: string } = {}): Response {
  const req = new NextRequest(`http://localhost${path}`, { method: opts.method ?? "GET", headers: opts.headers }) as NextRequest & { auth: unknown };
  req.auth = opts.auth ?? null;
  const res = middleware(req);
  if (!res) throw new Error("middleware 가 응답을 돌려주지 않았다");
  return res;
}

/** NextResponse.next({ request: { headers } }) 가 라우트로 넘길 요청 헤더 값. */
const forwarded = (res: Response) => res.headers.get("x-middleware-request-x-request-id");

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("RATE_LIMIT", "off");
  vi.stubEnv("AUTH_OPEN_API", "");
  middleware = (await import("./middleware")).default as unknown as Handler;
});
afterEach(() => vi.unstubAllEnvs());

describe("middleware x-request-id", () => {
  it("통과 경로: 없으면 uuid 를 만들어 응답 헤더와 라우트 요청 헤더 둘 다에 넣는다", () => {
    const res = call("/api/tasks", { auth: { user: { id: "u" } } });
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(UUID);
    expect(forwarded(res)).toBe(id);
    expect(res.headers.get("x-middleware-override-headers")).toContain("x-request-id");
  });

  it("들어온 x-request-id 가 안전한 형식이면 그대로 쓴다", () => {
    const res = call("/api/health", { headers: { "x-request-id": "edge-abc_123.4:5" } });
    expect(res.headers.get("x-request-id")).toBe("edge-abc_123.4:5");
    expect(forwarded(res)).toBe("edge-abc_123.4:5");
  });

  it("형식이 이상한(공백·너무 긴) 값은 버리고 새로 만든다", () => {
    const res = call("/api/health", { headers: { "x-request-id": "a b\" injected" } });
    expect(res.headers.get("x-request-id")).toMatch(UUID);
    const long = call("/api/health", { headers: { "x-request-id": "x".repeat(200) } });
    expect(long.headers.get("x-request-id")).toMatch(UUID);
  });

  it("공개 자산·/pub·/login·토큰 통과 경로도 헤더를 단다", () => {
    for (const [path, headers] of [
      ["/setup.sh", {}],
      ["/pub/tok/index.html", {}],
      ["/login", {}],
      ["/api/tasks", { "x-ws-token": "t" }],
    ] as const) {
      const res = call(path, { headers });
      expect(res.headers.get("x-request-id"), path).toMatch(UUID);
      expect(forwarded(res), path).toBe(res.headers.get("x-request-id"));
    }
  });

  it("401 응답에도 같은 헤더(동작은 그대로 401)", async () => {
    const res = call("/api/tasks", { headers: { "x-request-id": "r-401" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.get("x-request-id")).toBe("r-401");
  });

  it("로그인 리다이렉트에도 헤더(동작은 그대로 /login?callbackUrl=)", () => {
    const res = call("/docs?x=1", { headers: { "x-request-id": "r-302" } });
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("http://localhost/login?callbackUrl=%2Fdocs%3Fx%3D1");
    expect(res.headers.get("x-request-id")).toBe("r-302");
  });

  it("인증된 UI 페이지 통과에도 헤더", () => {
    const res = call("/docs", { auth: { user: { id: "u" } } });
    expect(res.headers.get("x-request-id")).toMatch(UUID);
    expect(forwarded(res)).toBe(res.headers.get("x-request-id"));
  });

  it("429 응답에도 헤더(Retry-After 유지)", async () => {
    vi.stubEnv("RATE_LIMIT", "on");
    vi.resetModules();
    middleware = (await import("./middleware")).default as unknown as Handler;
    let res: Response | null = null;
    for (let i = 0; i < 20 && (!res || res.status !== 429); i++) {
      res = call("/api/ask?q=x", { auth: { user: { id: "u" } }, headers: { "x-request-id": `r-${i}`, "x-forwarded-for": "9.9.9.9" } });
    }
    expect(res!.status).toBe(429);
    expect(res!.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(res!.headers.get("x-request-id")).toMatch(/^r-\d+$/);
  });
});

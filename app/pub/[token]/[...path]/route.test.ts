import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("@/lib/sites/server", () => ({ siteAccessById: vi.fn() }));
let root = "";
vi.mock("@/lib/sites/store", async (orig) => ({ ...(await orig<object>()), sitesRoot: () => root }));

import { siteAccessById } from "@/lib/sites/server";
import { writeVersion } from "@/lib/sites/store";
import { signSiteToken } from "@/lib/sites/token";
import { readProxyIdentity } from "@/lib/sites/proxyIdentity";
import { GET, POST, DELETE, OPTIONS } from "./route";

const m = (f: unknown) => f as Mock;
const call = (token: string, path: string[]) =>
  GET(new Request("http://t/pub"), { params: Promise.resolve({ token, path }) });

describe("GET /pub/[token]/[...path]", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("AUTH_SECRET", "s");
    root = await mkdtemp(join(tmpdir(), "pub-"));
    await writeVersion(root, "cs1", 2, [
      { path: "index.html", data: Buffer.from("<p>hi</p>") },
      { path: "a/app.js", data: Buffer.from("1") },
    ]);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("유효 토큰 + 초대 유효 → 파일과 샌드박스 헤더", async () => {
    m(siteAccessById).mockResolvedValue({ result: "ok" });
    const res = await call(signSiteToken({ siteId: "cs1", version: 2, email: "g@gmail.com" }), ["a", "app.js"]);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("1");
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(siteAccessById).toHaveBeenCalledWith("cs1", "g@gmail.com");
  });

  it("위조 토큰 → 403, DB 조회 없음", async () => {
    const res = await call("forged.token", ["index.html"]);
    expect(res.status).toBe(403);
    expect(siteAccessById).not.toHaveBeenCalled();
  });

  it("초대가 회수되면 기존 토큰도 403", async () => {
    m(siteAccessById).mockResolvedValue({ result: "forbidden" });
    const res = await call(signSiteToken({ siteId: "cs1", version: 2, email: "g@gmail.com" }), ["index.html"]);
    expect(res.status).toBe(403);
  });

  it("사이트 비활성·삭제 → 404", async () => {
    m(siteAccessById).mockResolvedValue({ result: "not_found" });
    const res = await call(signSiteToken({ siteId: "cs1", version: 2, email: "g@gmail.com" }), ["index.html"]);
    expect(res.status).toBe(404);
  });

  it("경로 이탈·없는 파일 → 404", async () => {
    m(siteAccessById).mockResolvedValue({ result: "ok" });
    const t = signSiteToken({ siteId: "cs1", version: 2, email: "g@gmail.com" });
    expect((await call(t, ["..", "..", "x"])).status).toBe(404);
    expect((await call(t, ["nope.html"])).status).toBe(404);
    expect((await call(t, ["a"])).status).toBe(404); // 디렉터리
  });
});

describe("/pub/[token]/api/* — upstream 프록시", () => {
  type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };
  let server: Server;
  let upstream = "";
  let seen: Seen[] = [];
  let reply: (res: import("node:http").ServerResponse, req: Seen) => void;

  const tok = () => signSiteToken({ siteId: "cs1", version: 2, email: "G@gmail.com" });
  const ok = (apiUpstream: string | null = upstream, member = false) =>
    m(siteAccessById).mockResolvedValue({ result: "ok", member, site: { id: "cs1", apiUpstream } });
  const params = (token: string, path: string[]) => ({ params: Promise.resolve({ token, path }) });

  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv("AUTH_SECRET", "s");
    root = await mkdtemp(join(tmpdir(), "pub-"));
    await writeVersion(root, "cs1", 2, [
      { path: "index.html", data: Buffer.from("<p>hi</p>") },
      { path: "api/data.json", data: Buffer.from('{"static":true}') },
    ]);
    seen = [];
    reply = (res) => {
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "up=1", "x-internal": "secret" });
      res.end(JSON.stringify({ ok: true }));
    };
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const s: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        seen.push(s);
        reply(res, s);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });

  it("POST: 바디·쿼리·허용 헤더 전달, 쿠키·authorization 미전달, 판정 헤더 추가, 응답 통과", async () => {
    ok(upstream, true);
    const req = new Request("http://t/pub/x/api/generate?mode=fast&n=2", {
      method: "POST",
      body: JSON.stringify({ prompt: "hi" }),
      headers: { "content-type": "application/json", accept: "application/json", cookie: "authjs.session-token=abc", authorization: "Bearer zzz", "x-ws-token": "t" },
    });
    const res = await POST(req, params(tok(), ["api", "generate"]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("x-internal")).toBeNull();

    expect(seen).toHaveLength(1);
    const s = seen[0];
    expect(s.method).toBe("POST");
    expect(s.url).toBe("/api/generate?mode=fast&n=2");
    expect(JSON.parse(s.body)).toEqual({ prompt: "hi" });
    expect(s.headers["content-type"]).toBe("application/json");
    expect(s.headers.accept).toBe("application/json");
    expect(s.headers["x-teamspace-site-id"]).toBe("cs1");
    expect(s.headers["x-teamspace-viewer"]).toBe("g@gmail.com");
    expect(s.headers["x-teamspace-member"]).toBe("true");
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers["x-ws-token"]).toBeUndefined();
    expect(s.headers.host).toBe(upstream.replace("http://", ""));
    expect(siteAccessById).toHaveBeenCalledWith("cs1", "G@gmail.com");
  });

  it("upstream status·body·content-type 그대로 (에러 응답 포함)", async () => {
    ok();
    reply = (res) => {
      res.writeHead(422, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad input");
    };
    const res = await POST(new Request("http://t/x", { method: "POST", body: "x" }), params(tok(), ["api", "generate"]));
    expect(res.status).toBe(422);
    expect(await res.text()).toBe("bad input");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("GET·DELETE 도 프록시 (사이트에 api/ 파일이 있어도 upstream 이 우선)", async () => {
    ok();
    const g = await GET(new Request("http://t/x?q=1"), params(tok(), ["api", "data.json"]));
    expect(g.status).toBe(200);
    expect(await g.json()).toEqual({ ok: true });
    const d = await DELETE(new Request("http://t/x", { method: "DELETE" }), params(tok(), ["api", "items", "7"]));
    expect(d.status).toBe(200);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /api/data.json?q=1", "DELETE /api/items/7"]);
  });

  it("판정 헤더에 프록시 서명이 함께 붙고, 그 요청(메서드·경로·본문)에 묶여 있다", async () => {
    ok(upstream, false);
    const payload = '{"items":[{"service":"Supabase","fields":[]}]}';
    await POST(new Request("http://t/x", { method: "POST", body: payload }), params(tok(), ["api", "site-intake"]));
    const sig = seen[0].headers["x-teamspace-proxy-sig"];
    expect(typeof sig).toBe("string");
    const h = new Headers({
      "x-teamspace-site-id": String(seen[0].headers["x-teamspace-site-id"]),
      "x-teamspace-viewer": String(seen[0].headers["x-teamspace-viewer"]),
      "x-teamspace-member": String(seen[0].headers["x-teamspace-member"]),
      "x-teamspace-proxy-sig": String(sig),
    });
    const bind = { method: "POST", path: "/api/site-intake", body: Buffer.from(payload, "utf8") };
    // 받는 쪽(readProxyIdentity)이 그대로 검증할 수 있어야 한다.
    expect(readProxyIdentity(h, bind)).toEqual({ siteId: "cs1", email: "g@gmail.com", member: false });
    // 그리고 다른 본문·경로·메서드로는 쓸 수 없어야 한다.
    expect(readProxyIdentity(h, { ...bind, body: Buffer.from("{}") })).toBeNull();
    expect(readProxyIdentity(h, { ...bind, path: "/api/sites/cs1/intake" })).toBeNull();
    expect(readProxyIdentity(h, { ...bind, method: "DELETE" })).toBeNull();
  });

  it("204 는 본문 없이", async () => {
    ok();
    reply = (res) => {
      res.writeHead(204);
      res.end();
    };
    const res = await DELETE(new Request("http://t/x", { method: "DELETE" }), params(tok(), ["api", "x"]));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("잘못된 토큰 → 403, 판정·upstream 호출 없음, CORS 로 페이지가 status 를 읽을 수 있다", async () => {
    const res = await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params("forged.token", ["api", "generate"]));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(siteAccessById).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it("초대 회수 → 403, upstream 호출 없음", async () => {
    m(siteAccessById).mockResolvedValue({ result: "forbidden", member: false, site: null });
    const res = await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params(tok(), ["api", "generate"]));
    expect(res.status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("사이트 비활성 → 404", async () => {
    m(siteAccessById).mockResolvedValue({ result: "not_found", member: false, site: null });
    const res = await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params(tok(), ["api", "generate"]));
    expect(res.status).toBe(404);
  });

  it("upstream 미설정 → POST 404, GET 은 기존 파일 서빙", async () => {
    ok(null);
    expect((await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params(tok(), ["api", "generate"]))).status).toBe(404);
    const g = await GET(new Request("http://t/x"), params(tok(), ["api", "data.json"]));
    expect(g.status).toBe(200);
    expect(await g.text()).toBe('{"static":true}');
    expect(g.headers.get("content-security-policy")).toMatch(/^sandbox /);
    expect(seen).toHaveLength(0);
  });

  it("api 밖 경로로 POST → 404", async () => {
    ok();
    expect((await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params(tok(), ["index.html"]))).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it("upstream 이 있어도 api 밖 GET 은 파일", async () => {
    ok();
    const g = await GET(new Request("http://t/x"), params(tok(), ["index.html"]));
    expect(await g.text()).toBe("<p>hi</p>");
    expect(seen).toHaveLength(0);
  });

  it("`..`·빈 세그먼트·백슬래시·인코딩된 슬래시 거부", async () => {
    ok();
    for (const path of [["api", ".."], ["api", "%2e%2e", "x"], ["api", ""], ["api", "a\\b"], ["api", "a%2Fb"]]) {
      const res = await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params(tok(), path));
      expect(res.status, path.join("/")).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("요청 바디 1MB 초과 → 413", async () => {
    ok();
    const big = Buffer.alloc(1024 * 1024 + 1, 97);
    const res = await POST(new Request("http://t/x", { method: "POST", body: big }), params(tok(), ["api", "generate"]));
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("연결 실패 → 502, 내부 주소 비노출", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    ok("http://127.0.0.1:1");
    const res = await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params(tok(), ["api", "generate"]));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "upstream 에 연결할 수 없습니다" });
    expect(text).not.toContain("127.0.0.1");
  });

  it("응답 5MB 초과 → 502", async () => {
    ok();
    reply = (res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(5 * 1024 * 1024 + 10, 1));
    };
    const res = await GET(new Request("http://t/x"), params(tok(), ["api", "big"]));
    expect(res.status).toBe(502);
  });

  it("타임아웃 → 504 (SITE_API_TIMEOUT_MS)", async () => {
    vi.stubEnv("SITE_API_TIMEOUT_MS", "50");
    ok();
    reply = (res) => {
      setTimeout(() => res.end("late"), 1000);
    };
    const res = await POST(new Request("http://t/x", { method: "POST", body: "{}" }), params(tok(), ["api", "slow"]));
    expect(res.status).toBe(504);
  });

  it("OPTIONS 프리플라이트 → 204 + CORS", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
  });
});

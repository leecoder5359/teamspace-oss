import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("@/lib/sites/server", () => ({ siteAccessById: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { siteIntakeEntry: { createMany: vi.fn() } } }));

import { siteAccessById } from "@/lib/sites/server";
import { prisma } from "@/lib/prisma";
import { decryptIntake, INTAKE_KEY_ENV } from "@/lib/sites/intakeCrypto";
import {
  PROXY_MEMBER_HEADER,
  PROXY_SIG_HEADER,
  PROXY_SITE_HEADER,
  PROXY_VIEWER_HEADER,
  signProxyIdentity,
} from "@/lib/sites/proxyIdentity";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const KEY = randomBytes(32).toString("base64");
const ID = { siteId: "cs1", email: "vendor@partner.com", member: false };
const URL_ = "http://t/api/site-intake";

const body = {
  items: [
    { service: "Supabase", fields: [{ label: "계정 이메일", value: "ops@partner.com" }, { label: "비밀번호", value: "hunter2-비밀" }] },
    { service: "도메인 등록처", fields: [{ label: "로그인 URL", value: "https://example.test" }] },
  ],
};

/** /pub 프록시가 실제로 붙이는 헤더 묶음 — 서명은 메서드·경로·본문에 묶인다. */
function proxyHeaders(payload: string, over: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "application/json",
    [PROXY_SITE_HEADER]: ID.siteId,
    [PROXY_VIEWER_HEADER]: ID.email,
    [PROXY_MEMBER_HEADER]: "false",
    [PROXY_SIG_HEADER]: signProxyIdentity(ID, { method: "POST", path: "/api/site-intake", body: Buffer.from(payload, "utf8") }),
    ...over,
  };
}

/** 프록시 경로로 온 정상 요청. */
function proxied(payload: string | object, over: Record<string, string> = {}) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return POST(new Request(URL_, { method: "POST", headers: proxyHeaders(text, over), body: text }));
}

const ok = () => m(siteAccessById).mockResolvedValue({ result: "ok", site: { id: "cs1" }, member: false });

describe("POST /api/site-intake — 게스트 제출(쓰기 전용)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AUTH_SECRET", "s");
    vi.stubEnv(INTAKE_KEY_ENV, KEY);
    m(prisma.siteIntakeEntry.createMany).mockResolvedValue({ count: 2 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("프록시 경로로 온 초대 게스트의 제출은 성공하고, 값은 암호화돼 저장된다", async () => {
    ok();
    const res = await proxied(body);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true, saved: 2 });
    expect(siteAccessById).toHaveBeenCalledWith("cs1", "vendor@partner.com");

    const rows = m(prisma.siteIntakeEntry.createMany).mock.calls[0][0].data as {
      siteId: string; service: string; secret: string; submittedBy: string; fieldCount: number;
    }[];
    expect(rows.map((r) => r.service)).toEqual(["Supabase", "도메인 등록처"]);
    expect(rows[0]).toMatchObject({ siteId: "cs1", submittedBy: "vendor@partner.com", fieldCount: 2 });
    for (const r of rows) {
      expect(r.secret).not.toContain("hunter2-비밀");
      expect(r.secret).not.toContain("ops@partner.com");
    }
    // AAD 는 그 행의 사이트·제출자·항목명이다.
    expect(JSON.parse(decryptIntake(rows[0].secret, { siteId: "cs1", submittedBy: "vendor@partner.com", service: "Supabase" })))
      .toEqual(body.items[0].fields);
    // 다른 행의 AAD 로는 안 풀린다
    expect(() => decryptIntake(rows[0].secret, { siteId: "cs1", submittedBy: "vendor@partner.com", service: "도메인 등록처" })).toThrow();
  });

  it("프록시 헤더가 없으면 403, DB 조회도 안 한다", async () => {
    const res = await POST(new Request(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect(res.status).toBe(403);
    expect(siteAccessById).not.toHaveBeenCalled();
    expect(prisma.siteIntakeEntry.createMany).not.toHaveBeenCalled();
  });

  it("서명 없이 헤더만 손으로 붙인 요청은 403", async () => {
    const text = JSON.stringify(body);
    const h = proxyHeaders(text);
    delete h[PROXY_SIG_HEADER];
    const res = await POST(new Request(URL_, { method: "POST", headers: h, body: text }));
    expect(res.status).toBe(403);
    expect(siteAccessById).not.toHaveBeenCalled();
  });

  it("다른 사이트·다른 이메일로 바꿔치기하면 403", async () => {
    expect((await proxied(body, { [PROXY_SITE_HEADER]: "cs2" })).status).toBe(403);
    expect((await proxied(body, { [PROXY_VIEWER_HEADER]: "attacker@evil.test" })).status).toBe(403);
    expect(siteAccessById).not.toHaveBeenCalled();
  });

  it("훔친 서명으로 **다른 본문**을 심을 수 없다 (서명이 본문에 묶여 있다)", async () => {
    ok();
    const stolen = proxyHeaders(JSON.stringify(body))[PROXY_SIG_HEADER];
    const evil = JSON.stringify({ items: [{ service: "GitHub", fields: [{ label: "로그인 URL", value: "https://phish.test" }] }] });
    const res = await POST(new Request(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROXY_SITE_HEADER]: ID.siteId,
        [PROXY_VIEWER_HEADER]: ID.email,
        [PROXY_MEMBER_HEADER]: "false",
        [PROXY_SIG_HEADER]: stolen,
      },
      body: evil,
    }));
    expect(res.status).toBe(403);
    expect(prisma.siteIntakeEntry.createMany).not.toHaveBeenCalled();
  });

  it("초대가 회수됐거나 사이트가 죽었으면 403 (서명이 유효해도)", async () => {
    for (const result of ["forbidden", "not_found"]) {
      m(siteAccessById).mockResolvedValue({ result, site: null });
      expect((await proxied(body)).status).toBe(403);
    }
    expect(prisma.siteIntakeEntry.createMany).not.toHaveBeenCalled();
  });

  it("SITE_INTAKE_KEY 가 없으면 503 — 아무것도 저장하지 않는다(fail closed)", async () => {
    vi.stubEnv(INTAKE_KEY_ENV, "");
    ok();
    const res = await proxied(body);
    expect(res.status).toBe(503);
    expect(prisma.siteIntakeEntry.createMany).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain(INTAKE_KEY_ENV);
  });

  it("키 설정 여부를 무인증으로 알려 주지 않는다 — 서명 없는 요청은 키 유무와 무관하게 403", async () => {
    // 헤더 하나만 붙여 본 익명 프로브. 예전엔 키 미설정이면 503, 설정이면 403 이라 구분됐다.
    const probe = () => POST(new Request(URL_, { method: "POST", headers: { [PROXY_SITE_HEADER]: "x" }, body: "{}" }));
    vi.stubEnv(INTAKE_KEY_ENV, KEY);
    expect((await probe()).status).toBe(403);
    vi.stubEnv(INTAKE_KEY_ENV, "");
    expect((await probe()).status).toBe(403);
  });

  it("content-length 를 속여도 상한에서 읽기를 끊는다", async () => {
    ok();
    const big = JSON.stringify({ items: [{ service: "s", fields: [{ label: "l", value: "x".repeat(300_000) }] }] });
    const res = await POST(new Request(URL_, {
      method: "POST",
      headers: { ...proxyHeaders(big), "content-length": "10" },
      body: big,
    }));
    expect(res.status).toBe(413);
    expect(prisma.siteIntakeEntry.createMany).not.toHaveBeenCalled();
  });

  it("약한 키(사람이 고른 문구)도 503 으로 막는다", async () => {
    vi.stubEnv(INTAKE_KEY_ENV, "우리팀이 정한 아주 긴 비밀 문구입니다 정말로 깁니다");
    ok();
    expect((await proxied(body)).status).toBe(503);
  });

  it("JSON 이 아니거나 형식이 틀리면 400", async () => {
    ok();
    expect((await proxied("not json")).status).toBe(400);
    expect((await proxied({ items: [] })).status).toBe(400);
    expect(prisma.siteIntakeEntry.createMany).not.toHaveBeenCalled();
  });

  it("값이 상한을 넘으면 **거절**한다 — 잘라서 저장하지 않는다", async () => {
    ok();
    const res = await proxied({ items: [{ service: "2FA", fields: [{ label: "백업코드", value: "x".repeat(4001) }] }] });
    expect(res.status).toBe(400);
    expect(prisma.siteIntakeEntry.createMany).not.toHaveBeenCalled();
  });

  it("본문이 상한을 넘으면 413", async () => {
    ok();
    const big = JSON.stringify({ items: [{ service: "s", fields: [{ label: "l", value: "x".repeat(300_000) }] }] });
    expect((await proxied(big)).status).toBe(413);
  });

  it("같은 게스트가 폭주하면 429 — 형식 오류는 한도를 깎지 않는다", async () => {
    ok();
    // 형식 오류 20번을 먼저 보내도 한도는 그대로여야 한다
    for (let i = 0; i < 20; i++) await proxied({ items: [] });
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i++) last = (await proxied(body)).status;
    expect(last).toBe(429);
  });

  it("게스트가 읽어 갈 경로가 없다(POST 만 export)", async () => {
    const mod = (await import("./route")) as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => ["GET", "PUT", "PATCH", "DELETE"].includes(k))).toEqual([]);
  });
});

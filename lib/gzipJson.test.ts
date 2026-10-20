import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { acceptsGzip, gzipJson } from "./gzipJson";

const req = (ae?: string) => new Request("http://x/api", { headers: ae ? { "accept-encoding": ae } : {} });
const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: `id-${i}`, title: "같은 제목이 반복된다" })) };

describe("acceptsGzip", () => {
  it("gzip 토큰이 있으면 true, q=0 이면 false", () => {
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br;q=1.0, GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("deflate, br")).toBe(false);
    expect(acceptsGzip(null)).toBe(false);
  });
});

describe("gzipJson", () => {
  it("gzip 허용 + 1KB 초과 → 압축 본문 + Content-Encoding·Vary", async () => {
    const res = await gzipJson(req("gzip, br"), big);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-type")).toBe("application/json");
    const raw = Buffer.from(await res.arrayBuffer());
    expect(raw.length).toBeLessThan(JSON.stringify(big).length);
    expect(JSON.parse(gunzipSync(raw).toString("utf8"))).toEqual(big);
  });

  it("1KB 이하 본문은 압축하지 않는다(Vary 는 단다)", async () => {
    const res = await gzipJson(req("gzip"), { ok: true });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("gzip 미허용·요청 없음 → 평문 JSON", async () => {
    for (const r of [req(), req("br"), undefined]) {
      const res = await gzipJson(r, big);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.json()).toEqual(big);
    }
  });

  it("status·추가 헤더를 그대로 넘긴다", async () => {
    const res = await gzipJson(req("gzip"), big, { status: 201, headers: { "x-a": "1" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  it("호출부가 준 Vary 는 덮지 않고 Accept-Encoding 을 덧붙인다(이미 있으면 그대로)", async () => {
    expect((await gzipJson(req("gzip"), big, { headers: { vary: "Cookie" } })).headers.get("vary")).toBe("Cookie, Accept-Encoding");
    expect((await gzipJson(req("gzip"), big, { headers: { vary: "accept-encoding" } })).headers.get("vary")).toBe("accept-encoding");
  });
});

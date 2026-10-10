import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/log", () => {
  const warn = vi.fn();
  return { log: { warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }, withReq: () => ({ warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }) };
});

import { log } from "@/lib/log";
import { POST, MAX_REPORT_BYTES } from "./route";

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://t/api/csp-report", { method: "POST", body, headers: { "content-type": "application/csp-report", ...headers } });

const report = JSON.stringify({
  "csp-report": {
    "document-uri": "https://x.test/p/abc?token=secret",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "blocked-uri": "https://evil.test/a.js?k=1",
    disposition: "report",
  },
});

describe("POST /api/csp-report", () => {
  beforeEach(() => vi.clearAllMocks());

  it("유효한 보고는 204 + warn(csp.violation) 로 핵심 필드만 남긴다(쿼리스트링 제거)", async () => {
    const res = await POST(post(report));
    expect(res.status).toBe(204);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [event, fields] = (log.warn as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0];
    expect(event).toBe("csp.violation");
    expect(fields.directive).toBe("script-src-elem");
    expect(fields.blocked).toBe("https://evil.test/a.js");
    expect(fields.document).toBe("https://x.test/p/abc");
  });

  it("Reporting API 형식(application/reports+json 배열)도 받는다", async () => {
    const body = JSON.stringify([{ type: "csp-violation", body: { documentURL: "https://x.test/", effectiveDirective: "img-src", blockedURL: "https://i.test/a.png" } }]);
    const res = await POST(post(body, { "content-type": "application/reports+json" }));
    expect(res.status).toBe(204);
    expect((log.warn as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls[0][1].directive).toBe("img-src");
  });

  it("본문이 2KB 를 넘으면 읽지 않고 413 (content-length 선검사)", async () => {
    const res = await POST(post("x", { "content-length": String(MAX_REPORT_BYTES + 1) }));
    expect(res.status).toBe(413);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("content-length 없이 실제 본문이 2KB 를 넘어도 413", async () => {
    const res = await POST(post("a".repeat(MAX_REPORT_BYTES + 10)));
    expect(res.status).toBe(413);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("깨진 JSON 은 로그 없이 204(보고 채널은 조용히)", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(204);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("본문 스트림이 중간에 끊겨도(클라이언트 중단) 500 이 아니라 204", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("aborted"));
      },
    });
    const req = new Request("http://t/api/csp-report", { method: "POST", body, duplex: "half" } as RequestInit);
    const res = await POST(req);
    expect(res.status).toBe(204);
    expect(log.warn).not.toHaveBeenCalled();
  });
});

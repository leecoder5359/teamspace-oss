import http from "node:http";
import https from "node:https";

/* 퍼블리시 사이트 API 프록시의 I/O — 요청 본문을 상한까지 읽고, upstream 을 한 번 호출해 응답을 상한까지 모은다.

   전역 fetch(undici) 대신 node:http 를 쓰는 이유: undici 는 headersTimeout·bodyTimeout 기본 300초라,
   수 분 걸리는 에이전트 요청이 SITE_API_TIMEOUT_MS(기본 10분)보다 먼저 끊긴다. 여기서는 전체 타이머 하나로만 끊는다. */

export type BodyRead = { ok: true; body: Buffer } | { ok: false; reason: "too_large" };

export async function readBodyLimited(req: Request, limit: number): Promise<BodyRead> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: "too_large" };
  if (!req.body) return { ok: true, body: Buffer.alloc(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "too_large" };
    }
    chunks.push(value);
  }
  return { ok: true, body: Buffer.concat(chunks) };
}

export type UpstreamResult =
  | { kind: "ok"; status: number; contentType: string | null; body: Buffer }
  | { kind: "connect_error" }
  | { kind: "bad_response" }
  | { kind: "too_large" }
  | { kind: "timeout" }
  | { kind: "aborted" };

export function callUpstream(
  url: string,
  o: { method: string; headers: Record<string, string>; body: Buffer | null; timeoutMs: number; maxResponseBytes: number; signal?: AbortSignal },
): Promise<UpstreamResult> {
  return new Promise((resolve) => {
    let settled = false;
    let responded = false;
    const finish = (r: UpstreamResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      resolve(r);
      req.destroy();
    };

    const target = new URL(url);
    const headers: Record<string, string> = { ...o.headers };
    if (o.body) headers["content-length"] = String(o.body.length);
    const mod = target.protocol === "https:" ? https : http;
    const req = mod.request(target, { method: o.method, headers, agent: false }, (res) => {
      responded = true;
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > o.maxResponseBytes) return finish({ kind: "too_large" });
        chunks.push(c);
      });
      res.on("end", () =>
        finish({ kind: "ok", status: res.statusCode ?? 502, contentType: headerValue(res.headers["content-type"]), body: Buffer.concat(chunks) }),
      );
      res.on("error", () => finish({ kind: "bad_response" }));
      res.on("aborted", () => finish({ kind: "bad_response" }));
    });
    req.on("error", () => finish(responded ? { kind: "bad_response" } : { kind: "connect_error" }));

    const timer = setTimeout(() => finish({ kind: "timeout" }), o.timeoutMs);
    // 보는 사람이 탭을 닫으면 upstream 작업도 끊는다(비싼 에이전트 호출이 헛돌지 않게).
    const onAbort = () => finish({ kind: "aborted" });
    if (o.signal?.aborted) return finish({ kind: "aborted" });
    o.signal?.addEventListener("abort", onAbort, { once: true });

    if (o.body && o.body.length) req.write(o.body);
    req.end();
  });
}

function headerValue(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

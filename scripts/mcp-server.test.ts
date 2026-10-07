import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * MCP 서버 ↔ /api 라우트 패리티 (2026-08-07 신설, 전수조사 D10).
 *
 * ws CLI 에는 패리티 테스트가 있었지만 **MCP 서버 18개 도구에는 하나도 없었다.**
 * MCP 는 에이전트가 이 워크스페이스를 만지는 주 통로인데, 라우트가 사라지거나
 * 메서드가 바뀌어도 아무것도 알려주지 않았다 — CLI 쪽에서 실제로 터진 것과
 * 똑같은 종류의 드리프트가 여기서는 감지조차 안 됐다.
 *
 * 검사 범위(ws.test.ts 와 같은 층):
 *   ① 도구가 부르는 경로에 대응하는 라우트 파일이 있는가
 *   ② 그 HTTP 메서드가 라우트에 export 돼 있는가
 *
 * 소스 문자열 검사라 타입 보장은 아니다 — '경로·메서드가 통째로 사라진'
 * 드리프트를 잡는 것이 목적이다.
 */

const ROOT = resolve(__dirname, "..");
const API_ROOT = resolve(ROOT, "app", "api");
const SRC = readFileSync(resolve(ROOT, "scripts", "mcp-server.ts"), "utf8");

/** api("METHOD", `/api/...`) 호출을 전부 뽑는다. 템플릿 변수는 [id] 세그먼트로 환원. */
function extractCalls(): { method: string; routeFile: string; raw: string }[] {
  const re = /api\(\s*"(GET|POST|PATCH|PUT|DELETE)"\s*,\s*[`"]([^`"]+)/g;
  const out: { method: string; routeFile: string; raw: string }[] = [];
  const seen = new Set<string>();
  for (const m of SRC.matchAll(re)) {
    const method = m[1];
    // 완결된 ${...} 만 동적 세그먼트로 환원하고, 중첩 템플릿(삼항 안의 백틱) 때문에
    // 잘려 들어온 미완결 ${ 이후는 버린다 — 그 뒤는 쿼리스트링이라 경로에 영향 없다.
    const path = m[2]
      .replace(/\$\{[^{}]*\}/g, "[id]")
      .replace(/\$\{[\s\S]*$/, "")
      .split("?")[0]
      .replace(/\/+$/, "");
    if (!path.startsWith("/api/")) continue;
    const routeFile = path.replace(/^\/api\//, "") + "/route.ts";
    const key = `${method} ${routeFile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method, routeFile, raw: m[2] });
  }
  return out;
}

const CALLS = extractCalls();

describe("MCP 서버 ↔ /api 라우트 패리티", () => {
  it("도구가 하나 이상 등록돼 있다", () => {
    expect(SRC.match(/registerTool\(/g)?.length ?? 0).toBeGreaterThan(0);
  });

  it("api() 호출을 하나 이상 추출했다 (정규식이 죽으면 이 테스트가 무력해진다)", () => {
    expect(CALLS.length).toBeGreaterThan(5);
  });

  for (const c of CALLS) {
    it(`${c.method} /api/${c.routeFile.replace("/route.ts", "")} — 라우트 파일이 있다`, () => {
      expect(existsSync(resolve(API_ROOT, c.routeFile)), `${c.raw} → ${c.routeFile}`).toBe(true);
    });

    it(`${c.method} /api/${c.routeFile.replace("/route.ts", "")} — ${c.method} 가 export 돼 있다`, () => {
      const src = readFileSync(resolve(API_ROOT, c.routeFile), "utf8");
      expect(src, `${c.raw}`).toMatch(new RegExp(`export async function ${c.method}\\b`));
    });
  }

  it("search 도구는 neighbors=1 로 부른다(그래프 이웃 동봉)", () => {
    const call = CALLS.find((c) => c.method === "GET" && c.routeFile === "search/route.ts");
    expect(call?.raw).toContain("neighbors=1");
  });
});

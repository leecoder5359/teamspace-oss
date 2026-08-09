import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * W1 보안 회귀 가드: 모든 API 라우트는 requireCtx(인증+워크스페이스+RBAC)를 거쳐야 한다.
 * 자체 인증 경로만 예외(화이트리스트). 새 라우트를 requireCtx 없이 추가하면 이 테스트가 깨진다.
 * (ws.test.ts 의 CLI↔라우트 패리티와 같은 정적 검증 방식.)
 */

const API_ROOT = join(__dirname, "..", "app", "api");

// 자체 인증(미들웨어 isOpenApi 와 일치해야 함):
//   auth  — Auth.js OAuth 콜백
//   health — 무인증 모니터링 프로브(최소 정보만)
//   ingest — HMAC x-ingest-signature
//   slack/interactions — 슬랙 서명
//   setup/script, setup/hooks/[name] — curl 설치기가 로그인 전에 내려받는 정적 스크립트(화이트리스트된 공개 파일만 서빙, 워크스페이스 데이터 없음)
//   pair/[code], pair/[code]/route-rule — 페어링 코드 자체 인증(만료·존재 검증이 게이트, requireCtx/세션 불필요).
//     CLI 가 로그인 쿠키 없이 폴링·route-rule 등록을 호출해야 하므로 공개. pair/approve 는 브라우저 로그인 세션이
//     증명 수단이라 requireCtx("admin") 세션 게이트를 유지 — 화이트리스트 제외.
const WHITELIST = new Set([
  "auth/[...nextauth]/route.ts",
  "health/route.ts",
  "ingest/route.ts",
  "slack/interactions/route.ts",
  "setup/script/route.ts",
  "setup/hooks/[name]/route.ts",
  "pair/[code]/route.ts",
  "pair/[code]/route-rule/route.ts",
]);

function collectRoutes(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...collectRoutes(full, rel));
    else if (name === "route.ts") out.push(rel);
  }
  return out;
}

describe("authz coverage", () => {
  const routes = collectRoutes(API_ROOT);

  it("라우트가 수집된다(스캐너 자체 검증)", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  for (const rel of routes) {
    if (WHITELIST.has(rel)) continue;
    it(`${rel} 는 requireCtx 를 사용한다`, () => {
      const src = readFileSync(join(API_ROOT, rel), "utf8");
      expect(
        src.includes("requireCtx("),
        `${rel} 에 requireCtx 호출이 없습니다 — 무인증 라우트는 금지(W1). 자체 인증이라면 WHITELIST 와 middleware.isOpenApi 에 함께 등록하세요.`,
      ).toBe(true);
    });
  }

  /* 미들웨어 matcher 에서 뺀 /api 경로는 **라우트 자체 게이트가 유일한 방어선**이다.
     (지금 하나뿐: api/import — 엣지 미들웨어가 10MB 넘는 본문을 깨뜨려서 뺐다.)
     여기에 requireCtx 가 없으면 그 경로는 통째로 무인증이 되므로 정적으로 강제한다. */
  it("미들웨어 matcher 에서 제외한 /api 경로는 requireCtx 로 스스로 막는다", () => {
    const mw = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8");
    const matcher = /matcher:\s*\[([\s\S]*?)\]/.exec(mw)?.[1] ?? "";
    const excluded = [...matcher.matchAll(/api\/([a-z0-9_\-/[\]]+)/gi)].map((m) => m[1]);
    // 제외 목록이 사라지면(정규식이 안 맞으면) 이 테스트가 조용히 통과하지 않도록
    expect(excluded).toContain("import");
    for (const path of excluded) {
      const candidates = routes.filter((r) => r === `${path}/route.ts` || r.startsWith(`${path}/`));
      expect(candidates.length, `middleware matcher 가 /api/${path} 를 뺐는데 그런 라우트가 없습니다`).toBeGreaterThan(0);
      for (const rel of candidates) {
        const src = readFileSync(join(API_ROOT, rel), "utf8");
        expect(
          src.includes("requireCtx("),
          `${rel} 은 미들웨어 밖(matcher 제외)인데 requireCtx 가 없습니다 — 무인증 구멍입니다.`,
        ).toBe(true);
      }
    }
  });

  it("화이트리스트 파일이 실제로 존재한다(오타 방지)", () => {
    for (const rel of WHITELIST) {
      expect(() => readFileSync(join(API_ROOT, rel), "utf8")).not.toThrow();
    }
  });
});

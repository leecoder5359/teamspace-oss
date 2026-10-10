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
//   site-intake — 퍼블리시 페이지의 폼 제출. /pub 프록시가 쿠키·authorization 을 떼어 내므로 세션으로는 올 수 없다.
//     프록시 서명(x-teamspace-proxy-sig, AUTH_SECRET 파생 MAC) + siteAccessById 초대 재판정이 자체 인증 게이트.
//     쓰기 전용(POST 만) — 게스트가 읽어 갈 경로가 없다.
//   csp-report — 브라우저가 CSP 위반을 자격 증명 없이 POST 한다. 쓰기 전용(로그만, 저장·읽기 경로 없음) ·
//     본문 2KB 상한 + 미들웨어 IP 당 1/분 레이트리밋(csp 정책)이 방어선.
const WHITELIST = new Set([
  "auth/[...nextauth]/route.ts",
  "health/route.ts",
  "ingest/route.ts",
  "slack/interactions/route.ts",
  "setup/script/route.ts",
  "setup/hooks/[name]/route.ts",
  "pair/[code]/route.ts",
  "pair/[code]/route-rule/route.ts",
  "site-intake/route.ts",
  "csp-report/route.ts",
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
     (api/import · api/sites — 엣지 미들웨어가 10MB 넘는 본문을 깨뜨려서 뺐다.)
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

  /* /pub API 프록시(초대 게스트)가 우리 /api/* 를 두드릴 수 없어야 한다.
     프록시는 경로 첫 세그먼트가 `api` 이기만 하면 무엇이든 upstream 으로 넘기고,
     그 upstream 이 앱 자신이면(인테이크 설치 안내가 그렇게 시킨다) 게스트 요청이
     /api/sites/** 로 들어온다 — AUTH_OPEN_API=true 면 거기서 세션 없이 admin 이 나갔다.
     requireCtx 가 프록시 헤더를 보고 통째로 끊는 것이 그 인터록이다(C1). */
  it("requireCtx 는 /pub 프록시에서 온 요청을 거절한다", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "workspace.ts"), "utf8");
    expect(src).toContain("hasProxyIdentityHeaders");
    // requireCtx 본문 안에 **호출이 실제로 있어야** 한다. (종전엔 indexOf 비교만 했는데,
    // 호출을 지우면 -1 이 나오고 `-1 < N` 이 참이라 공허하게 통과했다 — 가드가 위약이었다.)
    const body = src.slice(src.indexOf("export async function requireCtx"));
    expect(body).toMatch(/if \(await cameFromSiteProxy\(\)\) return forbidden\(/);
    // 그리고 **첫 관문**이어야 한다(세션 해석보다 먼저).
    const guardAt = body.indexOf("cameFromSiteProxy");
    const sessionAt = body.indexOf("resolveSessionCtx()");
    expect(guardAt).toBeGreaterThan(-1);
    expect(sessionAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(sessionAt);
  });

  /* 자격 증명을 다루는 인테이크 라우트는 AUTH_OPEN_API=true 부트스트랩 admin 위에서 열지 않는다. */
  it("인테이크 라우트는 부트스트랩(AUTH_OPEN_API) ctx 를 거절한다", () => {
    for (const rel of ["sites/[id]/intake/route.ts", "sites/[id]/intake/[entryId]/route.ts"]) {
      expect(readFileSync(join(API_ROOT, rel), "utf8"), rel).toContain("isBootstrapCtx");
    }
  });

  /* isOpenApi 의 게스트 제출 경로는 **정확 일치**여야 한다 — startsWith 로 바꾸면
     /api/site-intake/... 가 통째로 무인증이 된다. */
  it("middleware 의 /api/site-intake 개방은 정확 일치다", () => {
    const mw = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8");
    expect(mw).toContain('pathname === "/api/site-intake"');
    expect(mw).not.toContain('startsWith("/api/site-intake');
  });

  it("화이트리스트 파일이 실제로 존재한다(오타 방지)", () => {
    for (const rel of WHITELIST) {
      expect(() => readFileSync(join(API_ROOT, rel), "utf8")).not.toThrow();
    }
  });
});

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MANIFEST } from "./ws";

/**
 * 패리티 테스트: ws CLI 의 모든 명령이 선언한 엔드포인트(ep)가 실제
 * app/api 라우트 파일로 존재하는지 검증한다. 라우트가 사라지거나 경로가
 * 바뀌면 여기서 실패 → CLI/SKILL.md 갱신을 강제(드리프트 방지).
 */
const API_ROOT = resolve(__dirname, "..", "app", "api");

describe("ws CLI ↔ /api 라우트 패리티", () => {
  it("명령이 하나 이상 등록되어 있다", () => {
    expect(MANIFEST.length).toBeGreaterThan(0);
  });

  for (const cmd of MANIFEST) {
    for (const ep of cmd.ep) {
      it(`'${cmd.name}' → app/api/${ep} 존재`, () => {
        expect(existsSync(resolve(API_ROOT, ep))).toBe(true);
      });
    }
  }
});

/**
 * 디스패치 가능성 검증(감사 task-1 회귀 가드): 모든 등록 명령이
 * main 의 긴-접두사(3→2→1) 매칭으로 실제로 도달 가능해야 한다.
 */
describe("ws CLI 명령 디스패치 가능성", () => {
  const names = new Set(MANIFEST.map((c) => c.name));
  function resolveCmd(tokens: string[]): string | null {
    for (let n = Math.min(3, tokens.length); n >= 1; n--) {
      const name = tokens.slice(0, n).join(" ");
      if (names.has(name)) return name;
    }
    return null;
  }
  for (const cmd of MANIFEST) {
    it(`'${cmd.name}' 은 디스패치된다`, () => {
      // 명령 토큰 뒤에 인자가 붙은 상황을 재현
      expect(resolveCmd([...cmd.name.split(" "), "arg1"])).toBe(cmd.name);
    });
  }
  it("명령 이름은 3단어를 넘지 않는다(매칭 한계)", () => {
    for (const cmd of MANIFEST) expect(cmd.name.split(" ").length).toBeLessThanOrEqual(3);
  });
});

/**
 * 역방향 커버리지 (W8 agent-5/6): 모든 API 라우트가 CLI 명령의 ep 로 커버되어야 한다.
 * 예외(화이트리스트)는 CLI 성격이 아닌 것만: 자체인증·스트림.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REVERSE_WHITELIST = new Set([
  "auth/[...nextauth]/route.ts", // OAuth 콜백
  "ingest/route.ts", // 훅 자동 발신 전용
  "slack/interactions/route.ts", // 슬랙 콜백
  "events/route.ts", // SSE 스트림(브라우저 전용)
  "health/route.ts", // 모니터링 프로브
  "pair/approve/route.ts", // 페어링 승인(브라우저 로그인 세션 전용)
  "pair/[code]/route.ts", // CLI 폴링(페어링 코드 자체인증)
  "pair/[code]/route-rule/route.ts", // 설치기 route-rule 등록(페어링 게이트)
  "setup/script/route.ts", // curl 설치기 스크립트 서빙(공개 정적)
  "setup/hooks/[name]/route.ts", // 훅 서빙(화이트리스트 공개 정적)
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

describe("역방향 패리티: 라우트 → CLI 커버리지", () => {
  const covered = new Set(MANIFEST.flatMap((c) => c.ep));
  for (const rel of collectRoutes(API_ROOT)) {
    if (REVERSE_WHITELIST.has(rel)) continue;
    it(`${rel} 는 CLI 명령이 커버한다`, () => {
      expect(
        covered.has(rel),
        `${rel} 를 다루는 pnpm ws 명령이 없습니다 — 명령을 추가하거나(권장) 비CLI 성격이면 REVERSE_WHITELIST 에 사유와 함께 등록하세요.`,
      ).toBe(true);
    });
  }
});

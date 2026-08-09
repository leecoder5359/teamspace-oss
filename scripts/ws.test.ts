import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MANIFEST, RESOURCE_CONTRACTS } from "./ws";

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

/**
 * 필드·메서드 패리티 (2026-08-07 신설).
 *
 * 배경: 기존 패리티는 '명령 ↔ 라우트 파일 존재'만 봤다. 그래서 라우트에
 * PATCH 가 아예 없거나(glossary·entity·onboarding·changelog) 필드를 일부만
 * 받아도(qa·risk·dod) 통과했고, set 계열 7개가 405/400 으로 죽어 있었는데
 * 테스트는 초록이었다.
 *
 * 여기서는 CLI 가 실제로 보내는 것(RESOURCE_CONTRACTS)을 기준으로
 *   ① 목록/생성 라우트에 GET·POST 가 있는지
 *   ② 수정 라우트에 PATCH 가 있는지
 *   ③ CLI 가 보내는 body 키를 라우트 소스가 언급하는지
 * 를 본다.
 *
 * ③ 은 소스 문자열 검사라 타입 수준 보장은 아니다 — '필드가 통째로 빠진'
 * 드리프트를 잡는 것이 목적이고, 그게 실제로 일어난 사고였다.
 */
describe("ws CLI ↔ 라우트 메서드·필드 패리티", () => {
  const read = (rel: string) => readFileSync(resolve(API_ROOT, rel), "utf8");

  for (const c of RESOURCE_CONTRACTS) {
    const listRoute = `${c.path}/route.ts`;
    const idRoute = `${c.path}/[id]/route.ts`;

    it(`'${c.group} ls/add' → ${listRoute} 에 GET·POST 가 있다`, () => {
      const src = read(listRoute);
      expect(src).toMatch(/export async function GET/);
      expect(src).toMatch(/export async function POST/);
    });

    it(`'${c.group} set' → ${idRoute} 에 PATCH 가 있다`, () => {
      expect(existsSync(resolve(API_ROOT, idRoute))).toBe(true);
      expect(read(idRoute)).toMatch(/export async function PATCH/);
    });

    it(`'${c.group} rm' → ${idRoute} 에 DELETE 가 있다`, () => {
      expect(read(idRoute)).toMatch(/export async function DELETE/);
    });

    for (const key of c.bodyKeys) {
      it(`'${c.group} add' 가 보내는 '${key}' 를 ${listRoute} 가 읽는다`, () => {
        expect(read(listRoute)).toContain(key);
      });
      it(`'${c.group} set' 이 보내는 '${key}' 를 ${idRoute} 가 읽는다`, () => {
        expect(read(idRoute)).toContain(key);
      });
    }
  }
});

import { describe, expect, it } from "vitest";
import { decide } from "./deny-repo-docs.mjs";

// PreToolUse 훅 판정 로직: 레포에 md 문서를 쓰는 시도를 차단(문서는 TeamSpace doc으로만).
describe("decide", () => {
  it("docs/ 아래 md 쓰기를 차단한다", () => {
    expect(decide("/Users/ljun/dev/ljun/teamspace/docs/새-스펙.md").deny).toBe(true);
    expect(decide("/Users/ljun/dev/ljun/dangol-note/docs/기능/명세.md").deny).toBe(true);
    expect(decide("docs/relative.md").deny).toBe(true);
  });

  it("superpowers 스펙·플랜 경로를 확장자와 무관하게 차단한다", () => {
    expect(decide("/repo/docs/superpowers/specs/2026-07-05-foo-design.md").deny).toBe(true);
    expect(decide("/repo/docs/superpowers/plans/plan.txt").deny).toBe(true);
  });

  it("ralph 태스크 소스(tasks/prd*, .beads)를 차단한다", () => {
    expect(decide("/repo/tasks/prd.json").deny).toBe(true);
    expect(decide("/repo/tasks/prd-onboarding.md").deny).toBe(true);
    expect(decide("/repo/.beads/beads.jsonl").deny).toBe(true);
  });

  it("specs/·plans/ 디렉토리의 md를 차단한다", () => {
    expect(decide("/repo/specs/design.md").deny).toBe(true);
    expect(decide("/repo/plans/impl-plan.md").deny).toBe(true);
  });

  it("허용 파일명(README·AGENTS·CLAUDE·SKILL 등)은 docs/ 밖에서 허용한다", () => {
    expect(decide("/repo/README.md").deny).toBe(false);
    expect(decide("/repo/AGENTS.md").deny).toBe(false);
    expect(decide("/repo/CLAUDE.md").deny).toBe(false);
    expect(decide("/repo/packages/a/README.md").deny).toBe(false);
  });

  it(".claude/ 아래(스킬·메모리·설정)는 항상 허용한다", () => {
    expect(decide("/repo/.claude/skills/foo/SKILL.md").deny).toBe(false);
    expect(decide("/Users/ljun/.claude/projects/x/memory/note.md").deny).toBe(false);
  });

  it("임시 디렉토리·node_modules는 허용한다", () => {
    expect(decide("/private/tmp/claude-501/x/scratchpad/report.md").deny).toBe(false);
    expect(decide("/tmp/foo/docs/bar.md").deny).toBe(false);
    expect(decide("/repo/node_modules/pkg/docs/api.md").deny).toBe(false);
  });

  it("md가 아닌 코드 파일은 어디서든 허용한다", () => {
    expect(decide("/repo/docs-site/src/index.ts").deny).toBe(false);
    expect(decide("/repo/lib/docGuard.ts").deny).toBe(false);
    expect(decide("/repo/docs/assets/diagram.svg").deny).toBe(false);
  });

  it("file_path가 없으면 허용한다(방어적)", () => {
    expect(decide(undefined).deny).toBe(false);
    expect(decide("").deny).toBe(false);
  });

  it("차단 사유에 TeamSpace 저장 안내가 들어 있다", () => {
    const d = decide("/repo/docs/spec.md");
    expect(d.deny).toBe(true);
    expect(d.reason).toContain("TeamSpace");
    expect(d.reason).toContain("pnpm ws doc");
  });
});

/* ───────── 전수조사 D11: 기본 허용 → 기본 차단으로 뒤집은 것의 회귀 가드 ─────────
   AGENTS.md 는 "레포/디스크에 md 생성 금지 … 엔진 수준에서 차단"이라고 적어 두었는데
   실제로는 6개 패턴 deny-list(기본 허용)라 REPORT.md·notes/회의록.md 가 그냥 통과했다. */

describe("deny-repo-docs — md 는 기본 차단", () => {
  it("허용목록 밖의 md 는 위치와 무관하게 막는다", () => {
    for (const f of ["REPORT.md", "notes/회의록.md", "/Users/x/Desktop/설계.md", "src/a.mdx"]) {
      expect(decide(f).deny, f).toBe(true);
    }
  });

  it("저장소 메타문서·.claude·스크래치패드는 계속 통과한다", () => {
    for (const f of [
      "README.md",
      "AGENTS.md",
      "CLAUDE.md",
      ".claude/skills/teamspace/SKILL.md",
      "/private/tmp/claude-501/x/scratchpad/메모.md",
    ]) {
      expect(decide(f).deny, f).toBe(false);
    }
  });

  it("md 가 아닌 파일은 건드리지 않는다", () => {
    for (const f of ["lib/foo.ts", "app/page.tsx", "prisma/schema.prisma"]) {
      expect(decide(f).deny, f).toBe(false);
    }
  });

  it("안내 명령에 WS_TOKEN 접두어가 없다 — 있으면 에이전트 토큰을 가려 401 이 난다", () => {
    const r = decide("docs/설계.md");
    expect(r.deny).toBe(true);
    expect(r.reason).not.toContain("WS_TOKEN=");
    expect(r.reason).toContain("pnpm ws doc new");
  });
});

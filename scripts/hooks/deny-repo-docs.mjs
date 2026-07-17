#!/usr/bin/env node
/**
 * PreToolUse 훅: 레포/디스크에 md 문서를 만드는 Write/Edit 를 차단한다.
 *
 * 규칙(AGENTS.md): 스펙·플랜·리포트 등 모든 문서는 TeamSpace doc으로만 저장한다.
 * superpowers(brainstorming/writing-plans) 등 플러그인이 docs/ 에 md 를 커밋하려는
 * 기본 동작을 엔진 수준에서 강제 차단하고 TeamSpace 저장 경로를 안내한다.
 *
 * 등록: .claude/settings.json → hooks.PreToolUse (matcher: Write|Edit|MultiEdit|NotebookEdit)
 * 전역 사본: ~/.claude/hooks/deny-repo-docs.mjs (모든 레포에 적용)
 * 테스트: scripts/hooks/deny-repo-docs.test.ts (vitest)
 */

const ALLOWED_BASENAMES = new Set([
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "MEMORY.md",
  "SKILL.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE.md",
]);

// 이 경로들은 문서 규칙 대상이 아니다(설정·메모리·임시·의존성).
const ALLOW_PATTERNS = [
  /(^|\/)\.claude\//,
  /(^|\/)node_modules\//,
  /^\/(private\/)?tmp\//,
  /\/scratchpad(\/|$)/,
];

// 레포 문서 산출물 — TeamSpace doc 으로 가야 하는 것들.
const DENY_PATTERNS = [
  { re: /(^|\/)docs\/superpowers\//, what: "superpowers 스펙/플랜" },
  { re: /(^|\/)docs\/.+\.(md|mdx)$/, what: "레포 docs/ 문서" },
  { re: /(^|\/)tasks\/prd[^/]*\.(md|json)$/, what: "ralph PRD 태스크 소스" },
  { re: /(^|\/)\.beads\//, what: "ralph beads 태스크 소스" },
  { re: /(^|\/)specs?\/.+\.(md|mdx)$/, what: "스펙 문서" },
  { re: /(^|\/)plans?\/.+\.(md|mdx)$/, what: "플랜 문서" },
];

/**
 * @param {string|undefined} filePath
 * @returns {{deny: boolean, reason?: string}}
 */
export function decide(filePath) {
  if (!filePath) return { deny: false };
  const base = filePath.split("/").pop() ?? "";
  if (ALLOWED_BASENAMES.has(base)) return { deny: false };
  if (ALLOW_PATTERNS.some((re) => re.test(filePath))) return { deny: false };
  const hit = DENY_PATTERNS.find((p) => p.re.test(filePath));
  if (!hit) return { deny: false };
  return {
    deny: true,
    reason:
      `📄 ${hit.what}(${base}) 를 레포에 쓰는 것은 금지되어 있습니다 — 문서는 TeamSpace doc 으로만 저장합니다(AGENTS.md 규칙). ` +
      `대신: teamspace 레포에서 pnpm ws doc new "<제목>" --project <projectId> 로 문서를 만들고 ` +
      `PUT /api/pages/<id> {markdown} 으로 본문을 저장하세요(teamspace 스킬 참조). ` +
      `정말 레포 파일이 필요한 예외라면 사용자에게 확인을 받으세요.`,
  };
}

// 훅 엔트리: stdin 으로 PreToolUse 페이로드(JSON)를 받아 판정을 출력한다.
async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // 페이로드 파싱 실패 시 간섭하지 않는다.
  }
  const filePath = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
  const d = decide(filePath);
  if (!d.deny) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: d.reason,
      },
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

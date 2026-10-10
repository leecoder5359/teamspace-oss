import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// 테스트용 Vitest 설정. `@/` alias를 tsconfig와 동일하게 프로젝트 루트로 매핑.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    // .claude/worktrees: 진행 중인 서브에이전트 워크트리의 테스트를 메인 게이트가 주워 빨갛게 만들던 것 차단
    exclude: ["**/node_modules/**", ".next", "app/generated", ".claude/worktrees/**"],
  },
});

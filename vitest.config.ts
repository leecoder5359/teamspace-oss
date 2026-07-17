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
    exclude: ["node_modules", ".next", "app/generated"],
  },
});

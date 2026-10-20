import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleImports, staticImportClosure } from "./moduleImports";

describe("moduleImports", () => {
  it("여러 줄 import·부수효과 import·re-export 를 정적으로, import() 를 동적으로 잡는다", () => {
    const code = [
      `import {`,
      `  a,`,
      `  b,`,
      `} from "./multi";`,
      `import "./side";`,
      `import D from "./default";`,
      `export { x } from "./reexport";`,
      `export * from "./star";`,
      `const L = dynamic(() => import("./Lazy"), { ssr: false });`,
    ].join("\n");
    expect(moduleImports(code)).toEqual({ static: ["./multi", "./side", "./default", "./reexport", "./star"], dynamic: ["./Lazy"] });
  });

  it("타입 전용 import/export 는 런타임 의존이 아니므로 뺀다", () => {
    const code = `import type { T } from "./types";\nexport type { U } from "./more";\nimport { v } from "./value";`;
    expect(moduleImports(code).static).toEqual(["./value"]);
  });

  it("주석·문자열 속 import 문구는 잡지 않는다", () => {
    const code = `// import x from "./commented";\nconst s = 'import y from "./inString"';`;
    expect(moduleImports(code)).toEqual({ static: [], dynamic: [] });
  });
});

describe("staticImportClosure", () => {
  it("상대·@/ 경로를 따라가 간접 의존까지 모으고, 동적 import 는 따라가지 않는다", () => {
    const root = mkdtempSync(join(tmpdir(), "imports-"));
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "lib/a.ts"), `import { b } from "./b";\nconst c = () => import("./c");`);
    writeFileSync(join(root, "lib/b.ts"), `import { d } from "@/lib/d";`);
    writeFileSync(join(root, "lib/c.ts"), `import "node:fs";`);
    writeFileSync(join(root, "lib/d.ts"), `import { createHash } from "node:crypto";`);
    const specs = staticImportClosure(join(root, "lib/a.ts"), root);
    expect([...specs].sort()).toEqual(["./b", "@/lib/d", "node:crypto"]);
  });
});

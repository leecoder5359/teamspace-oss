/* =====================================================================
   import 가드 테스트용 — 소스의 모듈 지정자를 TypeScript 파서로 뽑는다.
   정규식으로 소스를 긁으면 여러 줄 import·`import "x"`·`export … from`·동적 import() 를 놓친다.
   타입 전용 import/export 는 번들에 실리지 않으므로 뺀다. 앱 코드는 이 모듈을 쓰지 않는다(테스트 전용).
   ===================================================================== */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";

export type ModuleImports = { static: string[]; dynamic: string[] };

/** 소스 한 개의 런타임 import 지정자(순수). static = import/export from, dynamic = import("…"). */
export function moduleImports(code: string, fileName = "x.tsx"): ModuleImports {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const out: ModuleImports = { static: [], dynamic: [] };
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly && ts.isStringLiteral(st.moduleSpecifier)) {
      out.static.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      out.static.push(st.moduleSpecifier.text);
    }
  }
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = n.arguments;
      if (arg && ts.isStringLiteralLike(arg)) out.dynamic.push(arg.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const EXTS = [".ts", ".tsx", "/index.ts", "/index.tsx"];

/** 레포 안 지정자(`./`·`../`·`@/`)를 파일 경로로 푼다. 패키지·node: 는 null. */
function resolveLocal(spec: string, fromFile: string, root: string): string | null {
  const base = spec.startsWith("@/") ? resolve(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(fromFile), spec) : null;
  if (!base) return null;
  if (existsSync(base) && /\.tsx?$/.test(base)) return base;
  return EXTS.map((e) => base + e).find((p) => existsSync(p)) ?? null;
}

/** entry 에서 정적 import 로 닿는 모든 지정자(레포 밖 패키지·node: 포함). 동적 import 는 따라가지 않는다. */
export function staticImportClosure(entry: string, root: string): Set<string> {
  const seen = new Set<string>();
  const specs = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of moduleImports(readFileSync(file, "utf8"), file).static) {
      specs.add(spec);
      const next = resolveLocal(spec, file, root);
      if (next) walk(next);
    }
  };
  walk(entry);
  return specs;
}

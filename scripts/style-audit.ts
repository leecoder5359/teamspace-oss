// 스타일 정적 감사(U-20·21·23). 시각 변화 0 을 증명하려고 리팩터 전후의 "해석된 값"을 비교한다.
//   tsx        — 파일별 인라인 스타일 값(fontSize·padding·borderRadius·color) 다중집합. 숫자는 px, --ds-* 토큰은 값으로 풀어 적는다.
//   constants  — 파일별 스타일 상수(CSSProperties 로 선언된 최상위 const)의 전체 속성. 상대 import 는 원본 파일에서 풀어 온다.
//   css        — globals.css → saebit.css 순서로 계산한 (컨텍스트, 선택자) → 선언 맵.
//   css-redundant / css-unused — 같은 선택자에 덮이는 선언 / 소스에 쓰이지 않는 ws-* 클래스 선택자.
//   tokens     — 토큰과 정확히 같은 리터럴(치환 대상)과 남는 리터럴(반 픽셀·비표준) 집계.
//   drift      — 반 픽셀 글자 크기·토큰 밖 반경 리터럴 목록. style-audit.test.ts 의 repo guard 가 0 을 기대한다(CI).
// 사용: pnpm exec tsx scripts/style-audit.ts <mode> > out.txt  (전후 diff 로 비교)
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const TRACKED_PROPS = ["fontSize", "padding", "borderRadius", "color"] as const;
// React 가 숫자에 px 를 붙이는 속성 중 우리가 추적하는 것
const PX_PROPS = new Set(["fontSize", "padding", "borderRadius"]);
const TOKEN_PREFIX: Record<string, string> = { fontSize: "--ds-fs-", borderRadius: "--ds-r-" };

export type Tokens = Record<string, string>;
export type StyleEntry = { line: number; prop: string; value: string; style: boolean };

// ---------------------------------------------------------------- tokens

export function parseTokens(css: string): Tokens {
  const out: Tokens = {};
  for (const rule of parseCss(css)) {
    if (rule.context !== "" || !rule.selectors.includes(":root")) continue;
    for (const d of rule.decls) if (/^--ds-(fs|r)-/.test(d.prop)) out[d.prop] = d.value;
  }
  return out;
}

const resolveVars = (s: string, tokens: Tokens) => s.replace(/var\((--[\w-]+)\)/g, (m, name: string) => tokens[name] ?? m);

// ---------------------------------------------------------------- tsx

function propName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return null;
}

function normalizeValue(prop: string, init: ts.Expression, tokens: Tokens): string {
  if (ts.isNumericLiteral(init)) return PX_PROPS.has(prop) ? `${init.text}px` : init.text;
  if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return resolveVars(init.text, tokens);
  return `expr:${init.getText()}`;
}

const mentionsCss = (t: ts.TypeNode | undefined) => !!t && /CSSProperties/.test(t.getText());

// 객체 리터럴이 스타일로 쓰이는지 — JSX style 속성 안이거나 CSSProperties 로 타입이 붙은 자리
function isStyleObject(node: ts.Node): boolean {
  let cur: ts.Node = node;
  for (;;) {
    const p = cur.parent;
    if (!p) return false;
    if (ts.isJsxExpression(p)) return ts.isJsxAttribute(p.parent) && p.parent.name.getText() === "style";
    if (ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
      if (mentionsCss(p.type)) return true;
    } else if (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isParameter(p)) {
      return mentionsCss(p.type);
    } else if (ts.isReturnStatement(p)) {
      let f: ts.Node | undefined = p.parent;
      while (f && !ts.isFunctionLike(f)) f = f.parent;
      return !!f && mentionsCss((f as ts.SignatureDeclaration).type);
    } else if (ts.isArrowFunction(p)) {
      return p.body === cur && mentionsCss(p.type);
    } else if (ts.isConditionalExpression(p)) {
      if (p.condition === cur) return false;
    } else if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind;
      if (k !== ts.SyntaxKind.AmpersandAmpersandToken && k !== ts.SyntaxKind.BarBarToken && k !== ts.SyntaxKind.QuestionQuestionToken) return false;
    } else if (!(ts.isParenthesizedExpression(p) || ts.isPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isObjectLiteralExpression(p))) {
      return false;
    }
    cur = p;
  }
}

function source(src: string) {
  return ts.createSourceFile("x.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function visitTracked(sf: ts.SourceFile, fn: (p: ts.PropertyAssignment, prop: string) => void) {
  const tracked = new Set<string>(TRACKED_PROPS);
  const walk = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && ts.isObjectLiteralExpression(n.parent)) {
      const name = propName(n);
      if (name && tracked.has(name)) fn(n, name);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
}

const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

export function scanTsx(src: string, tokens: Tokens): StyleEntry[] {
  const sf = source(src);
  const out: StyleEntry[] = [];
  visitTracked(sf, (p, prop) =>
    out.push({ line: lineOf(sf, p.initializer), prop, value: normalizeValue(prop, p.initializer, tokens), style: isStyleObject(p.parent) }),
  );
  return out;
}

export type TokenEdit = { line: number; prop: string; start: number; end: number; from: string; to: string };

// 토큰 값과 정확히 같은 fontSize·borderRadius 리터럴 → "var(--ds-*)". 나머지 리터럴은 kept 로.
export function tokenEdits(src: string, tokens: Tokens): { edits: TokenEdit[]; kept: StyleEntry[] } {
  const sf = source(src);
  const byValue = (prefix: string, v: string) => Object.keys(tokens).find((k) => k.startsWith(prefix) && tokens[k] === v);
  const edits: TokenEdit[] = [];
  const kept: StyleEntry[] = [];
  visitTracked(sf, (p, prop) => {
    const prefix = TOKEN_PREFIX[prop];
    const init = p.initializer;
    if (!prefix || !isStyleObject(p.parent)) return;
    const literal = ts.isNumericLiteral(init) || ts.isStringLiteral(init);
    if (!literal || init.getText().includes("var(")) return;
    const value = normalizeValue(prop, init, tokens);
    const token = /^\d+(\.\d+)?px$/.test(value) ? byValue(prefix, value) : undefined;
    const line = lineOf(sf, init);
    if (token) edits.push({ line, prop, start: init.getStart(sf), end: init.getEnd(), from: init.getText(), to: `"var(${token})"` });
    else kept.push({ line, prop, value, style: true });
  });
  return { edits, kept };
}

export function applyEdits(src: string, edits: TokenEdit[]): string {
  return [...edits].sort((a, b) => b.start - a.start).reduce((s, e) => s.slice(0, e.start) + e.to + s.slice(e.end), src);
}

// 가장 작은 반경 토큰(8px)보다 작은 미세 반경 — 색 견본 네모·kbd·하이라이트·진행 막대·체크박스. 8px 로 올리면 작은 네모가 동그라미가 된다.
export const MICRO_RADIUS = new Set(["2px", "3px", "4px", "5px"]);

export type Drift = { line: number; prop: "fontSize" | "borderRadius"; value: string };

// CI 가드: 반 픽셀 글자 크기, 토큰에도 MICRO_RADIUS 에도 없는 px 반경(여러 값 문자열은 칸별). 스타일 자리인지 따지지 않는다 —
// 타입 없는 상수에 담아 style 로 넘기면 isStyleObject 가 못 보기 때문.
export function driftLiterals(src: string, tokens: Tokens): Drift[] {
  const sf = source(src);
  const tokenValues = new Set(Object.entries(tokens).filter(([k]) => k.startsWith("--ds-r-")).map(([, v]) => v));
  const out: Drift[] = [];
  visitTracked(sf, (p, prop) => {
    const init = p.initializer;
    if (!ts.isNumericLiteral(init) && !ts.isStringLiteral(init)) return;
    const value = normalizeValue(prop, init, tokens);
    const line = lineOf(sf, init);
    if (prop === "fontSize" && /^\d+\.\d+px$/.test(value)) out.push({ line, prop, value });
    if (prop === "borderRadius")
      for (const part of value.split(/\s+/))
        if (/^\d+(\.\d+)?px$/.test(part) && !tokenValues.has(part) && !MICRO_RADIUS.has(part)) out.push({ line, prop, value: part });
  });
  return out;
}

export type ConstMap = Record<string, Record<string, string>>;

export function scanStyleConstants(src: string, tokens: Tokens): ConstMap {
  const sf = source(src);
  const out: ConstMap = {};
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !mentionsCss(d.type) || !d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
      const props: Record<string, string> = {};
      for (const p of d.initializer.properties) {
        if (ts.isSpreadAssignment(p)) {
          const earlier = ts.isIdentifier(p.expression) ? out[p.expression.text] : undefined;
          if (earlier) Object.assign(props, earlier);
          else props[`...${p.expression.getText()}`] = "spread";
        }
        else if (ts.isPropertyAssignment(p)) props[propName(p) ?? p.name.getText()] = normalizeValue(propName(p) ?? "", p.initializer, tokens);
        else props[p.name?.getText() ?? "?"] = "expr";
      }
      out[d.name.text] = props;
    }
  }
  return out;
}

// `import { a, b as c } from "./x"` → [{ local: c, imported: b, from: "./x" }]
function namedImports(src: string): { local: string; imported: string; from: string }[] {
  const sf = source(src);
  const out: { local: string; imported: string; from: string }[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const nb = st.importClause?.namedBindings;
    if (!nb || !ts.isNamedImports(nb)) continue;
    for (const el of nb.elements) out.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text, from: st.moduleSpecifier.text });
  }
  return out;
}

// ---------------------------------------------------------------- css

export type CssDecl = { prop: string; value: string; important: boolean };
export type CssRule = { selectors: string[]; context: string; decls: CssDecl[]; line: number; file: string };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

// 괄호·따옴표 밖의 구분자로 자른다
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function parseDecls(body: string): CssDecl[] {
  return splitTop(body, ";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      const raw = squash(d.slice(i + 1));
      const important = /!important$/.test(raw);
      return { prop: d.slice(0, i).trim(), value: important ? raw.replace(/\s*!important$/, "") : raw, important };
    });
}

export function parseCss(text: string, file = ""): CssRule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const rules: CssRule[] = [];
  const stack: string[] = [];
  let preludeStart = 0;
  let quote = "";
  let depth = 0;
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth > 0) continue;
    else if (c === ";") preludeStart = i + 1; // @import 등 문장형 at-rule, at-rule 블록 안의 바로 선언(@theme)
    else if (c === "}") {
      stack.pop();
      preludeStart = i + 1;
    } else if (c === "{") {
      const raw = src.slice(preludeStart, i);
      const prelude = squash(raw);
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        preludeStart = i + 1;
        continue;
      }
      const close = src.indexOf("}", i);
      const lead = raw.length - raw.trimStart().length;
      rules.push({
        selectors: splitTop(prelude, ",").map(squash),
        context: stack.join(" "),
        decls: parseDecls(src.slice(i + 1, close)),
        line: lineAt(preludeStart + lead),
        file,
      });
      i = close;
      preludeStart = close + 1;
    }
  }
  return rules;
}

const NON_CASCADE = /@keyframes|@theme|@font-face/;
const SIDES = ["top", "right", "bottom", "left"];
const SHORTHANDS: Record<string, string[]> = {
  padding: SIDES.map((s) => `padding-${s}`),
  margin: SIDES.map((s) => `margin-${s}`),
  inset: SIDES,
  background: ["background-color", "background-image"],
  border: ["border-width", "border-style", "border-color", ...SIDES.flatMap((s) => [`border-${s}`, `border-${s}-width`, `border-${s}-style`, `border-${s}-color`])],
  overflow: ["overflow-x", "overflow-y"],
  flex: ["flex-grow", "flex-shrink", "flex-basis"],
  gap: ["row-gap", "column-gap"],
  font: ["font-size", "font-family", "font-weight", "font-style", "line-height"],
};
const covers = (later: string, earlier: string) => later === earlier || (SHORTHANDS[later]?.includes(earlier) ?? false);
// 나중 규칙이 앞 규칙을 항상 덮으려면: 같은 선택자, 같은(또는 조건 없는) 컨텍스트
const applies = (later: CssRule, ctx: string) => later.context === "" || later.context === ctx;

export type Redundant = { file: string; line: number; selector: string; context: string; prop: string; value: string; by: string };

export function findRedundantDecls(rules: CssRule[], later: CssRule[]): Redundant[] {
  const all = [...rules, ...later].filter((r) => !NON_CASCADE.test(r.context));
  const out: Redundant[] = [];
  rules.forEach((rule) => {
    const idx = all.indexOf(rule);
    if (idx < 0) return;
    for (const selector of rule.selectors)
      for (const d of rule.decls) {
        const winner = all
          .slice(idx + 1)
          .find((r) => applies(r, rule.context) && r.selectors.includes(selector) && r.decls.some((x) => covers(x.prop, d.prop) && (x.important || !d.important)));
        if (winner) out.push({ file: rule.file, line: rule.line, selector, context: rule.context, prop: d.prop, value: d.value, by: `${winner.file}:${winner.line}` });
      }
  });
  return out;
}

export function effectiveDecls(rules: CssRule[]): Record<string, Record<string, string>> {
  const cascade = rules.filter((r) => !NON_CASCADE.test(r.context));
  const keys = new Set(cascade.flatMap((r) => r.selectors.map((s) => `${r.context} | ${s}`)));
  const out: Record<string, Record<string, string>> = {};
  for (const key of keys) {
    const [ctx, sel] = key.split(" | ");
    const map: Record<string, string> = {};
    for (const r of cascade) {
      if (!applies(r, ctx) || !r.selectors.includes(sel)) continue;
      for (const d of r.decls) {
        if (map[d.prop]?.endsWith("!important") && !d.important) continue;
        for (const long of SHORTHANDS[d.prop] ?? []) delete map[long];
        map[d.prop] = d.important ? `${d.value} !important` : d.value;
      }
    }
    out[key] = map;
  }
  return out;
}

function stripNot(sel: string): string {
  let out = "";
  for (let i = 0; i < sel.length; i++) {
    if (sel.startsWith(":not(", i)) {
      let depth = 0;
      for (let j = i + 4; j < sel.length; j++) {
        if (sel[j] === "(") depth++;
        else if (sel[j] === ")" && --depth === 0) {
          i = j;
          break;
        }
      }
      continue;
    }
    out += sel[i];
  }
  return out;
}

function classUsed(cls: string, sources: string[]): boolean {
  const esc = cls.replace(/[-]/g, "\\-");
  const whole = new RegExp(`(^|[^\\w-])${esc}([^\\w-]|$)`);
  // `ws-row--${tone}`·`ws-toc-l${level}` 처럼 템플릿으로 끝을 채우는 경우 — 접두사가 어디서 끊기든 쓰임으로 본다
  const prefixes = [...cls].flatMap((_, i) => (i > 2 ? [`${cls.slice(0, i + 1)}\${`] : []));
  return sources.some((s) => whole.test(s) || prefixes.some((p) => s.includes(p)));
}

export type Unused = { file: string; line: number; selector: string; context: string; missing: string[] };

export function unusedClassSelectors(rules: CssRule[], sources: string[]): Unused[] {
  const out: Unused[] = [];
  for (const r of rules)
    for (const selector of r.selectors) {
      const classes = [...new Set([...stripNot(selector).matchAll(/\.(ws-[\w-]+)/g)].map((m) => m[1]))];
      const missing = classes.filter((c) => !classUsed(c, sources));
      if (missing.length) out.push({ file: r.file, line: r.line, selector, context: r.context, missing });
    }
  return out;
}

// ---------------------------------------------------------------- cli (입출력은 여기만)

const ROOT = path.resolve(__dirname, "..");
const SRC_DIRS = ["app", "components", "lib"];

function listFiles(dir: string, ext: RegExp): string[] {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" || e.name === "node_modules" ? [] : listFiles(rel, ext);
    return ext.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const CSS_FILES = ["app/globals.css", "app/saebit.css"]; // app/layout.tsx 의 import 순서

function tsxFiles() {
  return SRC_DIRS.flatMap((d) => listFiles(d, /\.tsx$/)).sort();
}

function resolveImport(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.join(ROOT, path.dirname(fromFile)), spec) : null;
  if (!base) return null;
  const hit = [".tsx", ".ts"].map((e) => base + e).find((f) => fs.existsSync(f));
  return hit ? path.relative(ROOT, hit) : null;
}

// 스타일시트 없이 혼자 서야 하는 화면 — 토큰(var(--ds-*))이 풀리지 않으니 리터럴을 그대로 둔다.
export const DRIFT_ALLOW_FILES: Record<string, string> = {
  "app/global-error.tsx": "루트 레이아웃까지 깨졌을 때 뜨는 화면이라 스타일시트가 안 올 수 있다",
  "app/offline/page.tsx": "서비스 워커가 미리 받아 두는 오프라인 화면이라 외부 자원에 기대지 않는다",
};

// 6–7px 반경이 한 변 14px 이하인 요소에 붙은 자리 — 8px 로 올리면 모양이 바뀐다(높이 12 막대의 반경 6 은 반원 끝).
export const DRIFT_ALLOW_VALUES: Record<string, { values: string[]; reason: string }> = {
  "components/ws/Dashboard.tsx": { values: ["borderRadius=6px"], reason: "상태 분포 막대(높이 12px)의 반원 끝" },
};

export function driftReport(): string[] {
  const tokens = parseTokens(read("app/saebit.css"));
  return tsxFiles()
    .filter((f) => !(f in DRIFT_ALLOW_FILES))
    .flatMap((f) =>
      driftLiterals(read(f), tokens)
        .filter((d) => !DRIFT_ALLOW_VALUES[f]?.values.includes(`${d.prop}=${d.value}`))
        .map((d) => `${f}:${d.line}\t${d.prop}=${d.value}`),
    );
}

function main(mode: string): string[] {
  const tokens = parseTokens(read("app/saebit.css"));
  const rules = () => CSS_FILES.flatMap((f) => parseCss(read(f), f));
  switch (mode) {
    case "tsx":
      return tsxFiles().flatMap((f) => {
        const counts = new Map<string, number>();
        for (const e of scanTsx(read(f), tokens)) {
          const k = `${e.style ? "style" : "other"}\t${e.prop}=${e.value}`;
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
        return [...counts].map(([k, n]) => `${f}\t${k}\tx${n}`).sort();
      });
    case "constants": {
      const cache = new Map<string, ConstMap>();
      const consts = (f: string) => cache.get(f) ?? cache.set(f, scanStyleConstants(read(f), tokens)).get(f)!;
      return tsxFiles().flatMap((f) => {
        const local = Object.entries(consts(f));
        const imported = namedImports(read(f)).flatMap((im) => {
          const target = resolveImport(f, im.from);
          const m = target ? consts(target)[im.imported] : undefined;
          return m ? [[im.local, m] as const] : [];
        });
        return [...local, ...imported].map(([name, m]) => `${f}\t${name}\t${JSON.stringify(Object.fromEntries(Object.entries(m).sort()))}`).sort();
      });
    }
    case "css":
      return Object.entries(effectiveDecls(rules()))
        .flatMap(([key, m]) => Object.entries(m).map(([p, v]) => `${key}\t${p}: ${v}`))
        .sort();
    case "css-redundant": {
      const [g, s] = CSS_FILES.map((f) => parseCss(read(f), f));
      return findRedundantDecls(g, s).map((r) => `${r.file}:${r.line}\t${r.context || "-"}\t${r.selector}\t${r.prop}: ${r.value}\tby ${r.by}`);
    }
    case "css-unused": {
      const sources = [...SRC_DIRS.flatMap((d) => listFiles(d, /\.(tsx?|js|html)$/)), ...listFiles("public", /\.(js|html)$/)].map(read);
      return unusedClassSelectors(rules(), sources).map((u) => `${u.file}:${u.line}\t${u.context || "-"}\t${u.selector}\tmissing ${u.missing.join(",")}`);
    }
    case "tokens":
      return tsxFiles().flatMap((f) => {
        const { edits, kept } = tokenEdits(read(f), tokens);
        if (!edits.length && !kept.length) return [];
        const keptBy = (prop: string) => kept.filter((k) => k.prop === prop).length;
        const exact = (prop: string) => edits.filter((e) => e.prop === prop).length;
        return [`${f}\tfontSize exact=${exact("fontSize")} kept=${keptBy("fontSize")}\tborderRadius exact=${exact("borderRadius")} kept=${keptBy("borderRadius")}`];
      });
    case "drift":
      return driftReport();
    default:
      throw new Error(`unknown mode: ${mode} (tsx | constants | css | css-redundant | css-unused | tokens | drift)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename ?? "")) {
  process.stdout.write(main(process.argv[2] ?? "tsx").join("\n") + "\n");
}

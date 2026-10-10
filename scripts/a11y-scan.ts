// 아이콘 전용 컨트롤에 접근 가능한 이름(aria-label/title/텍스트)이 있는지 정적 검사한다.
// 대상: <button>, role="button" 요소, <a>/<Link>, 래퍼 컴포넌트(이름이 Button/Btn 으로 끝남 — FilterBtn·ApproveButton 등),
// trigger 속성으로 버튼 내용을 받는 컴포넌트(TaskDetail 의 Menu 등).
// 오탐은 허용하지 않는다: 알 수 없는 표현식 자식은 "텍스트 있음"으로 간주한다.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export type Finding = { file: string; line: number; snippet: string };

const NAME_ATTRS = new Set(["aria-label", "aria-labelledby", "title"]);
// 래퍼 컴포넌트는 label 같은 prop 으로 이름을 받아 안쪽 <button> 의 텍스트로 렌더한다.
const WRAPPER_NAME_ATTRS = new Set([...NAME_ATTRS, "label"]);
// 이름 없는 장식용 컴포넌트(아이콘류). 그 밖의 대문자 컴포넌트는 이름성 prop 이 있으면 텍스트로 본다.
const ICON_TAGS = new Set(["Icon", "svg"]);
const LINK_TAGS = new Set(["a", "Link"]);
const WRAPPER_RE = /^[A-Z]\w*(Button|Btn)$/;
const HAS_TEXT = /[\p{L}\p{N}]/u;

function tagName(el: ts.JsxOpeningLikeElement): string {
  return el.tagName.getText();
}

// 빈 문자열 리터럴(`=""`, `={""}`)은 이름이 없는 것과 같다. 그 밖의 표현식은 알 수 없음 → 있음으로 본다.
function isEmptyLiteral(init: ts.JsxAttribute["initializer"]): boolean {
  if (!init) return false;
  if (ts.isStringLiteral(init)) return !init.text.trim();
  if (ts.isJsxExpression(init) && init.expression) {
    const e = init.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return !e.text.trim();
  }
  return false;
}

// `{...props}` 는 aria-label 등을 실어 올 수 있다 — 알 수 없음 → 이름이 있을 수 있는 것으로 본다.
function hasAttr(el: ts.JsxOpeningLikeElement, names: Set<string>): boolean {
  return el.attributes.properties.some(
    (p) => ts.isJsxSpreadAttribute(p) || (ts.isJsxAttribute(p) && names.has(p.name.getText()) && !isEmptyLiteral(p.initializer)),
  );
}

function altHasText(el: ts.JsxOpeningLikeElement): boolean {
  return el.attributes.properties.some((p) => {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== "alt") return false;
    const init = p.initializer;
    if (!init) return false;
    if (ts.isStringLiteral(init)) return HAS_TEXT.test(init.text);
    // 표현식 alt 는 알 수 없음 → 텍스트로 간주
    return true;
  });
}

// 접근 가능한 텍스트를 줄 수 있는(혹은 알 수 없는) 자식이 있는가
function childHasText(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return HAS_TEXT.test(node.text);
  if (ts.isJsxExpression(node)) {
    const e = node.expression;
    if (!e) return false; // {} 또는 {/* 주석 */}
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return HAS_TEXT.test(e.text);
    return true; // 식별자·호출·조건식 등 → 알 수 없음
  }
  if (ts.isJsxFragment(node)) return node.children.some(childHasText);
  if (ts.isJsxSelfClosingElement(node)) return elementHasText(node, []);
  if (ts.isJsxElement(node)) return elementHasText(node.openingElement, node.children);
  return false;
}

function elementHasText(open: ts.JsxOpeningLikeElement, children: readonly ts.Node[]): boolean {
  const name = tagName(open);
  if (name === "img") return altHasText(open);
  if (ICON_TAGS.has(name)) return false;
  // 중첩된 알 수 없는 컴포넌트: label/title/aria-label 로 텍스트를 받으면 있음으로 본다(<StatusPill label=…/>).
  if (/^[A-Z]/.test(name) && hasAttr(open, WRAPPER_NAME_ATTRS)) return true;
  return children.some(childHasText);
}

function attrInit(el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute["initializer"] | null {
  for (const p of el.attributes.properties) {
    if (ts.isJsxAttribute(p) && p.name.getText() === name) return p.initializer;
  }
  return null;
}

function hasRoleButton(el: ts.JsxOpeningLikeElement): boolean {
  const init = attrInit(el, "role");
  if (!init) return false;
  if (ts.isStringLiteral(init)) return init.text === "button";
  if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteral(init.expression)) {
    return init.expression.text === "button";
  }
  return false;
}

// trigger={…} 로 버튼 내용을 받는 컴포넌트 — 그 표현식이 이름을 줄 수 있는가
function triggerHasText(el: ts.JsxOpeningLikeElement): boolean | null {
  const init = attrInit(el, "trigger");
  if (init === null) return null;
  if (!init) return false;
  if (ts.isStringLiteral(init)) return HAS_TEXT.test(init.text);
  if (ts.isJsxExpression(init)) {
    const e = init.expression;
    if (!e) return false;
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return childHasText(e);
    return childHasText(init);
  }
  return true;
}

type Kind = "button" | "role" | "link" | "wrapper" | "trigger";

function controlKind(open: ts.JsxOpeningLikeElement): Kind | null {
  const name = tagName(open);
  if (name === "button") return "button";
  if (LINK_TAGS.has(name)) return "link";
  if (WRAPPER_RE.test(name)) return "wrapper";
  if (hasRoleButton(open)) return "role";
  if (/^[A-Z]/.test(name) && attrInit(open, "trigger") !== null) return "trigger";
  return null;
}

export function scanIconButtons(
  files: readonly string[],
  read: (f: string) => string,
): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    const src = read(file);
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const check = (open: ts.JsxOpeningLikeElement, children: readonly ts.Node[]) => {
      const kind = controlKind(open);
      if (!kind) return;
      if (kind === "trigger") {
        // 트리거 내용이 버튼 안쪽 텍스트가 된다. children 은 메뉴 본문(렌더 함수)이라 이름에 안 들어간다.
        if (hasAttr(open, NAME_ATTRS) || triggerHasText(open)) return;
      } else {
        if (hasAttr(open, kind === "wrapper" ? WRAPPER_NAME_ATTRS : NAME_ATTRS)) return;
        if (children.some(childHasText)) return;
      }
      const line = sf.getLineAndCharacterOfPosition(open.getStart(sf)).line + 1;
      out.push({ file, line, snippet: open.getText(sf).split("\n")[0].trim().slice(0, 100) });
    };
    const visit = (n: ts.Node) => {
      if (ts.isJsxElement(n)) check(n.openingElement, n.children);
      else if (ts.isJsxSelfClosingElement(n)) check(n, []);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

function walk(dir: string, acc: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "generated") continue;
      walk(p, acc);
    } else if (e.name.endsWith(".tsx") && !e.name.endsWith(".test.tsx")) acc.push(p);
  }
}

export function scanRepo(root: string): Finding[] {
  const files: string[] = [];
  walk(path.join(root, "components"), files);
  walk(path.join(root, "app"), files);
  files.sort();
  const found = scanIconButtons(files, (f) => fs.readFileSync(f, "utf8"));
  return found.map((f) => ({ ...f, file: path.relative(root, f.file) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename ?? "")) {
  const found = scanRepo(process.cwd());
  for (const f of found) console.log(`${f.file}:${f.line}  ${f.snippet}`);
  console.log(`total: ${found.length}`);
  process.exit(found.length ? 1 : 0);
}

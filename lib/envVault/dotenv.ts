/* =====================================================================
   .env 파일 파싱·직렬화 (env 금고 CLI 용, 순수 함수).

   지원: `KEY=VALUE`, `export KEY=VALUE`, 빈 줄·`#` 주석, 작은따옴표(그대로),
   큰따옴표(\n \r \t \" \\ 이스케이프), 따옴표 없는 값의 ` #` 인라인 주석.
   여러 줄 값은 큰따옴표 안의 \n 으로만 표현한다(P1). 주석·순서 보존 쓰기는 P2 이후.
   에러 메시지에는 줄 번호·키 이름만 넣고 값은 넣지 않는다.
   ===================================================================== */

export type EnvPair = { key: string; value: string };

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)?$/;

function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" })[c] ?? c);
}

export function parseDotenv(text: string): EnvPair[] {
  const out = new Map<string, string>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const m = LINE_RE.exec(line);
    if (!m) throw new Error(`.env ${i + 1}번째 줄을 해석할 수 없습니다.`);
    const key = m[1];
    let raw = (m[2] ?? "").trim();
    let value: string;
    if (raw.startsWith('"')) {
      const end = findClosingQuote(raw, '"');
      if (end < 0) throw new Error(`.env ${i + 1}번째 줄(${key})의 큰따옴표가 닫히지 않았습니다.`);
      value = unescapeDouble(raw.slice(1, end));
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      if (end < 0) throw new Error(`.env ${i + 1}번째 줄(${key})의 작은따옴표가 닫히지 않았습니다.`);
      value = raw.slice(1, end);
    } else {
      const hash = raw.search(/\s#/);
      if (hash >= 0) raw = raw.slice(0, hash);
      value = raw.trim();
    }
    out.set(key, value); // 같은 키가 또 나오면 뒤엣것(dotenv 와 같은 규칙)
  });
  return [...out].map(([key, value]) => ({ key, value }));
}

function findClosingQuote(s: string, q: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

/** 값 → .env 표현. 단순 값은 그대로, 공백·따옴표·#·줄바꿈 등이 있으면 큰따옴표로 감싼다. */
export function formatValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value;
  const esc = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${esc}"`;
}

export function serializeDotenv(vars: EnvPair[], header?: string): string {
  const lines = header ? header.split("\n").map((l) => `# ${l}`) : [];
  for (const v of vars) lines.push(`${v.key}=${formatValue(v.value)}`);
  return lines.join("\n") + "\n";
}

/**
 * 기존 .env 텍스트에 vars 를 합친다(push 의 dotenv 대상). 주석·빈 줄·다른 키·순서는 그대로 두고,
 * 같은 키 줄만 값 표현을 바꾼다(`export ` 접두사 유지). 없던 키는 끝에 붙인다. 줄바꿈(CRLF/LF)은 원래 것을 따른다.
 * 값은 formatValue 로 한 줄에 담기므로(여러 줄은 \n 이스케이프) 줄 단위 교체가 안전하다.
 */
export function mergeDotenv(text: string, vars: EnvPair[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const want = new Map(vars.map((v) => [v.key, v.value]));
  const seen = new Set<string>();
  const body = text.replace(/(\r?\n)+$/, "");
  const lines = body === "" ? [] : body.split(/\r?\n/);
  const out = lines.map((line) => {
    if (line.trim().startsWith("#")) return line;
    const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)\s*=/.exec(line);
    if (!m || !want.has(m[2])) return line;
    seen.add(m[2]);
    return `${m[1]}${m[2]}=${formatValue(want.get(m[2])!)}`;
  });
  for (const v of vars) if (!seen.has(v.key)) out.push(`${v.key}=${formatValue(v.value)}`);
  return out.join(eol) + eol;
}

/** 키 이름 기준 diff(값 비교 없음) — 파일 덮어쓰기 전 안내용. */
export function keyNameDiff(current: string[], next: string[]): { added: string[]; removed: string[]; kept: string[] } {
  const c = new Set(current);
  const n = new Set(next);
  return {
    added: [...n].filter((k) => !c.has(k)).sort(),
    removed: [...c].filter((k) => !n.has(k)).sort(),
    kept: [...n].filter((k) => c.has(k)).sort(),
  };
}

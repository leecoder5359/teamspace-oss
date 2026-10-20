/* Claude 메모리 파일(~/.claude/projects/<cwd 인코딩>/memory/*.md) → 내 개인 레슨 올리기(pnpm ws lesson import-memory)의 순수 로직.
   frontmatter: 최상위 name·description, type 은 최상위 또는 `metadata:` 아래 들여쓴 키(lib/md 의 parseFrontmatter 는 들여쓴 줄을 버려 못 쓴다).
   파일 IO·입력은 scripts/ws.ts 가 한다. */

export type MemoryEntry = { file: string; name: string; description: string; type: string | null; body: string };

/** YAML 스칼라 따옴표 벗기기 — 큰따옴표는 \" · \\ 이스케이프, 작은따옴표는 '' 를 푼다. */
function unquote(raw: string): string {
  const s = raw.trim();
  const m = /^(['"])(.*)\1$/.exec(s);
  if (!m) return s;
  return m[1] === '"' ? m[2].replace(/\\(["\\])/g, "$1") : m[2].replace(/''/g, "'");
}

/** frontmatter 가 없거나 닫히지 않으면 null(MEMORY.md 같은 색인). 빈 name 은 그대로 "" — 채우지 않는다(호출부가 보고 후 건너뜀). */
export function parseMemoryFile(src: string, file: string): MemoryEntry | null {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close <= 0) return null;
  const top: Record<string, string> = {};
  const nested: Record<string, string> = {};
  for (const l of lines.slice(1, close)) {
    const m = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
    if (!m) continue;
    (m[1] ? nested : top)[m[2]] = unquote(m[3]);
  }
  return {
    file,
    name: top.name ?? "",
    description: top.description ?? "",
    type: top.type || nested.type || null,
    body: lines.slice(close + 1).join("\n").trim(),
  };
}

export function matchesType(e: { type: string | null }, want: string): boolean {
  return want === "any" || e.type === want;
}

/** 제목 = description, 본문 = 파일 본문. name·description·본문 중 빠진 게 있으면 그 목록. */
export function toLesson(e: MemoryEntry): { ok: true; title: string; body: string } | { ok: false; missing: string[] } {
  const missing = [
    !e.name.trim() && "name",
    !e.description.trim() && "description",
    !e.body.trim() && "body",
  ].filter((x): x is string => !!x);
  return missing.length ? { ok: false, missing } : { ok: true, title: e.description.trim(), body: e.body };
}

/** Claude Code 의 프로젝트 폴더 이름 규칙: 절대 경로의 영숫자 외 문자를 '-' 로. */
export function memoryDirFor(cwd: string, home: string): string {
  return `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/memory`;
}

/** 내부 주소로 볼 도메인 — 배포 URL(WS_BASE·PUBLIC_BASE_URL 등, 쉼표 목록 가능)의 호스트. 3단 이상이면 첫 칸을 빼 형제 서브도메인도 잡는다.
    localhost·IP 는 제외(IP 는 scanSecrets 의 tailscale 규칙이 따로 본다). 하드코딩 대신 env 에서 받는다(OSS 이식성). */
export function internalDomains(urls: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const raw of urls.flatMap((u) => (u ?? "").split(","))) {
    const s = raw.trim();
    if (!s) continue;
    let host: string;
    try {
      host = new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (!host || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) continue;
    const labels = host.split(".");
    out.add(labels.length >= 3 ? labels.slice(1).join(".") : host);
  }
  return [...out];
}

export type SecretHit = { line: number; kind: "token" | "email" | "host"; excerpt: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const BASE_RULES: { kind: SecretHit["kind"]; re: RegExp }[] = [
  { kind: "token", re: /\b(wst_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{6,}|xox[abposr]-[A-Za-z0-9-]{4,})/ },
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  // tailscale: *.ts.net, CGNAT 100.64.0.0/10. localhost·사설 대역은 흔한 안내라 제외.
  { kind: "host", re: /\b[\w-]+(\.[\w-]+)*\.ts\.net\b|\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/ },
];

/** 개인 레슨은 기본 공개 — 올리기 전에 비밀처럼 보이는 줄을 알려 준다(줄당 첫 규칙 하나). 발췌는 줄 안의 같은 종류 값을 모두 앞 4자만 남긴다. */
export function scanSecrets(text: string, domains: string[] = []): SecretHit[] {
  const rules = domains.length
    ? [...BASE_RULES, { kind: "host" as const, re: new RegExp(`(?<![\\w.-])([\\w-]+\\.)*(${domains.map(escapeRe).join("|")})\\b`, "i") }]
    : BASE_RULES;
  const out: SecretHit[] = [];
  text.split("\n").forEach((l, i) => {
    for (const r of rules) {
      if (r.re.test(l)) {
        const masked = l.replace(new RegExp(r.re.source, `${r.re.flags}g`), (v) => `${v.slice(0, 4)}…`);
        out.push({ line: i + 1, kind: r.kind, excerpt: masked.trim().slice(0, 120) });
        break;
      }
    }
  });
  return out;
}

/** "1,3,5-7" | "a" | "all" → 1-기반 번호들(정렬·중복 제거). 빈칸 = [](취소). 잘못되면 null. */
export function parseSelection(input: string, max: number): number[] | null {
  const s = input.trim().toLowerCase();
  if (!s) return [];
  if (s === "a" || s === "all") return Array.from({ length: max }, (_, i) => i + 1);
  const set = new Set<number>();
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > max || a > b) return null;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return [...set].sort((x, y) => x - y);
}

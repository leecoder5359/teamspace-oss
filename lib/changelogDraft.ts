// 배포 시 변경 이력 초안(D-3) — git log 의 feat/fix/perf 커밋을 ChangelogEntry 1건으로 만든다. 순수 모듈(IO 없음).

export type CommitLine = { hash: string; subject: string; date: string };

/** `git log --format=%h%x09%ad%x09%s --date=short` 출력 → 커밋 목록. 탭이 모자란 줄은 버린다. */
export function parseGitLog(raw: string): CommitLine[] {
  const out: CommitLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf("\t");
    const j = i < 0 ? -1 : line.indexOf("\t", i + 1);
    if (i < 0 || j < 0) continue;
    const subject = line.slice(j + 1).trim();
    if (!subject) continue;
    out.push({ hash: line.slice(0, i).trim(), date: line.slice(i + 1, j).trim(), subject });
  }
  return out;
}

/** `YYYY-MM-DD` | `YYYY.MM.DD` → `YYYY.MM.DD`. */
function dotted(date: string): string {
  return date.replace(/-/g, ".");
}

/** 같은 날 버전이 이미 있으면 `.2`, `.3` … 으로 올린다. */
export function nextVersion(existing: readonly string[], date: string): string {
  const base = dotted(date);
  const taken = new Set(existing.map((v) => v.trim()));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const v = `${base}.${n}`;
    if (!taken.has(v)) return v;
  }
}

const SUBJECT_RE = /^(feat|fix|perf)(?:\(([^)]*)\))?!?:\s*(.+)$/;

function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 자동 초안이 만든 항목인가 — 버전 `YYYY.MM.DD(.N)` + 제목 `배포 …`. 수동 릴리스 노트(다른 제품 포함)는 앵커가 아니다. */
export function isAutoDraftEntry(e: { version?: string | null; title?: string | null }): boolean {
  return /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/.test(e.version ?? "") && (e.title ?? "").startsWith("배포");
}

/** 기본 since 앵커 = 자동 초안 항목 중 가장 최근 releasedAt. 없으면 undefined(호출부가 7일 전으로). */
export function pickAnchor(
  entries: readonly { version?: string | null; title?: string | null; releasedAt?: string | null }[],
): string | undefined {
  let newest: string | undefined;
  for (const e of entries) {
    if (!e.releasedAt || !isAutoDraftEntry(e)) continue;
    if (!newest || e.releasedAt > newest) newest = e.releasedAt;
  }
  return newest;
}

export type AnchorSource = "project" | "shared" | "default";

/**
 * since 앵커를 어디서 구할지 정한다. 프로젝트 항목이 하나라도 있으면 그쪽만 본다(다른 제품 이력은 범위에 영향 없음).
 * 프로젝트 항목이 아직 0건이면 공용 항목으로 폴백 — 안 그러면 첫 프로젝트 태그 초안이 공용 초안이
 * 이미 덮은 7일치 커밋을 다시 나열한다. 버전 번호는 폴백일 때 두 목록을 합쳐 센다(같은 날 공용 .n 과 충돌 방지).
 */
export function pickAnchorSource(
  projectEntries: readonly { version?: string | null; title?: string | null; releasedAt?: string | null }[],
  sharedEntries: readonly { version?: string | null; title?: string | null; releasedAt?: string | null }[] = [],
): { source: AnchorSource; anchor?: string; existingVersions: string[] } {
  const versionsOf = (es: readonly { version?: string | null }[]) => es.map((e) => e.version).filter((v): v is string => typeof v === "string");
  if (projectEntries.length > 0) {
    const anchor = pickAnchor(projectEntries);
    return { source: anchor ? "project" : "default", anchor, existingVersions: versionsOf(projectEntries) };
  }
  const anchor = pickAnchor(sharedEntries);
  return { source: anchor ? "shared" : "default", anchor, existingVersions: versionsOf(sharedEntries) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * --since 값 → git log 범위 인자. 날짜(YYYY-MM-DD, ISO 시각 허용)면 `--since=`, 아니면 `<ref>..HEAD`.
 * `-` 로 시작하면 git 옵션 주입이라 거부한다.
 */
export function gitRangeArg(since: string): string {
  if (!since || since.startsWith("-")) throw new Error(`--since 값이 올바르지 않습니다: ${since || "(빈 값)"}`);
  return DATE_RE.test(since) ? `--since=${since}` : `${since}..HEAD`;
}

/** 기간 표기용 — 날짜·ISO 시각은 YYYY-MM-DD 로, ref 는 그대로. */
function sinceLabel(since: string): string {
  return DATE_RE.test(since) ? since.slice(0, 10) : since;
}

export const MAX_BULLETS = 50;

/**
 * feat/fix/perf 커밋만 골라 scope 별로 묶은 불릿 본문을 만든다. 0건이면 null.
 * title = `배포 YYYY-MM-DD`, version = `nextVersion(existingVersions, today)`.
 * 본문 첫 줄은 `기간: <since> ~ <today>`(since 없으면 가장 이른 커밋 날짜), 불릿은 MAX_BULLETS 개까지 + `… 외 N건`.
 * today(YYYY-MM-DD)·existingVersions 는 테스트·CLI 가 주입한다(기본: 오늘·없음).
 */
export function draftFromCommits(
  commits: readonly CommitLine[],
  opts: { since?: string; today?: string; existingVersions?: readonly string[]; maxBullets?: number },
): { title: string; version: string; body: string } | null {
  const scoped = new Map<string, string[]>();
  const plain: string[] = [];
  let earliest: string | undefined;
  for (const c of commits) {
    const m = SUBJECT_RE.exec(c.subject.trim());
    if (!m) continue;
    const scope = m[2]?.trim();
    const text = m[3].trim();
    if (!text) continue;
    if (c.date && (!earliest || c.date < earliest)) earliest = c.date;
    if (scope) {
      const list = scoped.get(scope) ?? [];
      list.push(text);
      scoped.set(scope, list);
    } else plain.push(text);
  }
  const bullets: string[] = [];
  for (const [scope, texts] of scoped) for (const t of texts) bullets.push(`- ${scope}: ${t}`);
  for (const t of plain) bullets.push(`- ${t}`);
  if (bullets.length === 0) return null;
  const today = opts.today ?? localDate(new Date());
  const max = opts.maxBullets ?? MAX_BULLETS;
  const shown = bullets.slice(0, max);
  if (bullets.length > max) shown.push(`… 외 ${bullets.length - max}건`);
  const from = opts.since ? sinceLabel(opts.since) : (earliest ?? today);
  const body = [`기간: ${from} ~ ${today}`, "", ...shown].join("\n");
  return { title: `배포 ${today}`, version: nextVersion(opts.existingVersions ?? [], today), body };
}

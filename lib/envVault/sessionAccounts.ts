/* =====================================================================
   세션 계정 주입(P3c, 순수) — 세션 컨텍스트에 "이 프로젝트는 이 계정" 줄을 만든다.

   env 금고 반영 대상(EnvTarget)의 기대 계정(account)·설정(config)에서 뽑는다. 목적은 계정 착각
   방지(Vercel 계정 두 개, 회사 GITHUB_TOKEN vs 개인 gh, AWS 프로필).
   - 종류별로 한 줄(aws > vercel > gha > dotenv 순), 중복 제거, 최대 3줄, 본문 합계 ≤ 300자.
   - config·account 는 비밀이 아니다(targets.ts 가 저장 때 looksSecret 으로 거부). 금고 변수 이름·값은
     입력으로 받지도 않는다.
   - 경로의 $HOME 은 ~ 로 줄인다.
   ===================================================================== */

export type AccountTargetLite = { kind: string; config: unknown; account: unknown };

export const ACCOUNT_SECTION_TITLE = "## 계정 (env 금고 반영 대상)";
export const ACCOUNT_LINES_MAX = 3;
export const ACCOUNT_CHARS_MAX = 300;

const KIND_ORDER = ["ssm", "vercel", "gha", "dotenv"] as const;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** 중복 제거 후 앞 n 개 + '외 N'. */
function list(values: (string | null)[], sep = "·", n = 3): string {
  const u = [...new Set(values.filter((v): v is string => !!v))];
  return u.length > n ? `${u.slice(0, n).join(sep)} 외 ${u.length - n}` : u.join(sep);
}

export function shortenHome(p: string, home: string | null | undefined): string {
  if (!home || home === "/") return p;
  const h = home.replace(/\/+$/, "");
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function kindLine(kind: string, ts: AccountTargetLite[], home: string | null | undefined): string | null {
  const cfg = ts.map((t) => rec(t.config));
  const acc = ts.map((t) => rec(t.account));
  switch (kind) {
    case "ssm": {
      const ids = list(acc.map((a) => str(a.accountId)));
      const profiles = list(cfg.map((c) => str(c.profile)));
      const head = [ids ? `계정 ${ids}` : "계정 미지정", profiles && `프로필 ${profiles}`].filter(Boolean).join(" · ");
      return `- AWS: ${head} (SSM ${list(cfg.map((c) => str(c.prefix)))})`;
    }
    case "vercel": {
      const users = list(acc.map((a) => str(a.user)));
      const scopes = list(cfg.map((c) => str(c.scope)));
      const dirs = list(cfg.map((c) => { const d = str(c.globalDir); return d && `-Q ${shortenHome(d, home)}`; }));
      const head = [users || "계정 미지정", scopes && `scope ${scopes}`, dirs].filter(Boolean).join(" · ");
      return `- Vercel: ${head} (프로젝트 ${list(cfg.map((c) => str(c.project)))})`;
    }
    case "gha": {
      const logins = list(acc.map((a) => str(a.login)));
      return `- GitHub: ${logins || "계정 미지정"} (gh 는 GITHUB_TOKEN 을 비우고: env -u GITHUB_TOKEN gh …)`;
    }
    case "dotenv": {
      const paths = list(cfg.map((c) => { const p = str(c.path); return p && shortenHome(p, home); }));
      return paths ? `- 로컬 .env: ${paths} (계정 확인 없음)` : null;
    }
    default:
      return null;
  }
}

/** 대상 → 계정 줄(제목 제외). 대상이 없으면 []. maxLines 로 brief 등에서 더 줄일 수 있다. */
export function buildAccountLines(
  targets: AccountTargetLite[],
  opts: { home?: string | null; maxLines?: number; maxChars?: number } = {},
): string[] {
  const maxLines = Math.min(opts.maxLines ?? ACCOUNT_LINES_MAX, ACCOUNT_LINES_MAX);
  const maxChars = opts.maxChars ?? ACCOUNT_CHARS_MAX;
  const lines: string[] = [];
  for (const k of KIND_ORDER) {
    const ts = targets.filter((t) => t.kind === k);
    if (!ts.length) continue;
    const l = kindLine(k, ts, opts.home);
    if (l) lines.push(l);
    if (lines.length >= maxLines) break;
  }
  if (!lines.length) return [];
  // 줄마다 같은 몫(줄바꿈 1자 포함)을 준다 — 합계가 maxChars 를 넘지 않는다.
  const per = Math.floor(maxChars / lines.length) - 1;
  return lines.map((l) => clip(l, per));
}

/** 컨텍스트에 끼울 섹션(제목 + 줄 + 빈 줄). 대상이 없으면 [] — 출력이 종전과 바이트 단위로 같다. */
export function accountSection(lines: string[]): string[] {
  return lines.length ? [ACCOUNT_SECTION_TITLE, ...lines, ""] : [];
}

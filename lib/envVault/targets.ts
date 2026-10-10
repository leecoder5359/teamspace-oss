import { z } from "zod";

/* =====================================================================
   env 금고 push 대상(EnvTarget) 설정 — 순수 함수(서버 서비스와 CLI 가 같은 규칙을 쓴다).

   - config·account 는 **비밀이 아니다**(경로·이름·기대 계정). 그래도 실수로 토큰을 붙여 넣는 일을
     막기 위해 모든 문자열을 looksSecret 으로 검사해 거부한다.
   - 종류별 모양은 zod strictObject 로 고정한다 — 모르는 필드로 값을 실어 나르지 못하게.
   - 에러 메시지에는 입력값을 넣지 않는다(필드 이름만).
   ===================================================================== */

export const TARGET_KINDS = ["dotenv", "ssm", "vercel", "gha"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const VERCEL_TARGETS = ["development", "preview", "production"] as const;

export const KIND_LABEL: Record<TargetKind, string> = {
  dotenv: "로컬 .env 파일",
  ssm: "AWS SSM",
  vercel: "Vercel",
  gha: "GitHub Actions",
};

export class TargetConfigError extends Error {}

// 흔한 토큰·키 모양(접두사) + 자격 증명이 들어간 URL
const SECRET_SHAPES = [
  /(^|[^A-Za-z0-9])(sk|pk|rk)_(live|test)_/,
  /xox[abposr]-/,
  /gh[pousr]_[A-Za-z0-9]{16,}/,
  /github_pat_/,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/,
  /eyJ[A-Za-z0-9_-]{8,}\./,
  /-----BEGIN/,
  /AIza[0-9A-Za-z_-]{20,}/,
  /\bsbp_[A-Za-z0-9]{16,}/,
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]+@/i,
];

/** 비밀 값처럼 보이는가 — 알려진 토큰 모양이거나, 구분자 없는 32자 이상 덩어리에 영문·숫자가 섞여 있으면. */
export function looksSecret(s: string): boolean {
  if (SECRET_SHAPES.some((re) => re.test(s))) return true;
  // UUID 모양은 경로(임시 폴더·세션 폴더)에 흔하다 — 덩어리 검사에서 뺀다
  const rest = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/");
  for (const chunk of rest.split(/[\s/\\.:@,]+/)) {
    if (chunk.length >= 32 && /^[A-Za-z0-9+=_-]+$/.test(chunk) && /[A-Za-z]/.test(chunk) && /[0-9]/.test(chunk)) return true;
  }
  return false;
}

const NOT_SECRET = "비밀 값처럼 보이는 문자열은 넣을 수 없습니다(대상 설정에는 경로·이름·계정만)";
const text = (max: number, re?: RegExp, what = "형식이 올바르지 않습니다") => {
  let s = z.string().trim().min(1).max(max);
  if (re) s = s.regex(re, { message: what });
  return s.refine((v) => !looksSecret(v), { message: NOT_SECRET });
};
const localPath = text(500, /^(\/|~\/)/, "절대 경로(/… 또는 ~/…)여야 합니다");
const NAME_RE = /^[A-Za-z0-9._-]+$/;

const CONFIG = {
  dotenv: z.strictObject({ path: localPath }),
  ssm: z.strictObject({
    prefix: text(300, /^\/[A-Za-z0-9_.\/-]*$/, "/ 로 시작하는 경로여야 합니다(예: /myapp/dev)"),
    region: text(32, /^[a-z]{2}(-[a-z]+)+-\d+$/, "리전 형식이 아닙니다(예: ap-northeast-2)").optional(),
    profile: text(64, NAME_RE).optional(),
  }),
  vercel: z.strictObject({
    project: text(100, NAME_RE, "Vercel 프로젝트 이름(또는 id)이어야 합니다"),
    target: z.enum(VERCEL_TARGETS, { message: "target 은 development·preview·production 중 하나" }),
    scope: text(100, NAME_RE).optional(),
    globalDir: localPath.optional(),
  }),
  gha: z.strictObject({
    repo: text(200, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "owner/repo 형식이어야 합니다"),
    environment: text(100, NAME_RE).optional(),
  }),
} as const;

/** 기대 계정 — 반영 직전 CLI 가 실제 로그인 계정과 비교한다. */
const ACCOUNT = {
  dotenv: z.strictObject({}),
  ssm: z.strictObject({ accountId: text(12, /^\d{12}$/, "AWS 계정 id(숫자 12자리)여야 합니다") }),
  vercel: z.strictObject({ user: text(100, NAME_RE, "Vercel 사용자 이름이어야 합니다") }),
  gha: z.strictObject({ login: text(100, /^[A-Za-z0-9-]+$/, "GitHub 로그인 이름이어야 합니다") }),
} as const;

export type DotenvConfig = z.infer<typeof CONFIG.dotenv>;
export type SsmConfig = z.infer<typeof CONFIG.ssm>;
export type VercelConfig = z.infer<typeof CONFIG.vercel>;
export type GhaConfig = z.infer<typeof CONFIG.gha>;
export type TargetSpec =
  | { kind: "dotenv"; config: DotenvConfig; account: Record<string, never> }
  | { kind: "ssm"; config: SsmConfig; account: { accountId: string } }
  | { kind: "vercel"; config: VercelConfig; account: { user: string } }
  | { kind: "gha"; config: GhaConfig; account: { login: string } };

function issueText(prefix: string, e: z.ZodError): string {
  const i = e.issues[0];
  const field = i?.path.length ? i.path.join(".") : "";
  // unrecognized_keys 는 키 이름만 알려 준다(값은 넣지 않는다)
  const msg = i?.code === "unrecognized_keys" ? `모르는 필드: ${(i as { keys: string[] }).keys.join(", ")}` : i?.message ?? "형식 오류";
  return `${prefix}${field ? `.${field}` : ""}: ${msg}`;
}

/** kind·config·account 검증 + 정규화. 실패하면 TargetConfigError(메시지에 값 없음). */
export function parseTarget(kind: unknown, config: unknown, account: unknown): TargetSpec & { identity: string } {
  if (typeof kind !== "string" || !(TARGET_KINDS as readonly string[]).includes(kind)) {
    throw new TargetConfigError(`kind 는 ${TARGET_KINDS.join("·")} 중 하나여야 합니다.`);
  }
  const k = kind as TargetKind;
  const c = CONFIG[k].safeParse(config ?? {});
  if (!c.success) throw new TargetConfigError(issueText("config", c.error));
  const a = ACCOUNT[k].safeParse(account ?? {});
  if (!a.success) throw new TargetConfigError(issueText("account", a.error));
  const cfg = { ...c.data } as Record<string, string>;
  if (k === "ssm") cfg.prefix = cfg.prefix.length > 1 ? cfg.prefix.replace(/\/+$/, "") : cfg.prefix;
  const spec = { kind: k, config: cfg, account: a.data } as TargetSpec;
  return { ...spec, identity: targetIdentity(spec) };
}

/** 같은 곳을 두 번 등록하지 않게 하는 정체 문자열(유니크 키의 일부). */
export function targetIdentity(t: TargetSpec): string {
  switch (t.kind) {
    case "dotenv":
      return t.config.path;
    case "ssm":
      return `${t.config.region ?? ""}:${t.config.prefix}`;
    case "vercel":
      return `${t.config.scope ?? ""}/${t.config.project}:${t.config.target}`;
    case "gha":
      return `${t.config.repo}:${t.config.environment ?? ""}`;
  }
}

/** 화면·CLI 용 한 줄 요약(비밀 없음). */
export function targetSummary(kind: string, config: unknown): string {
  const c = (config ?? {}) as Record<string, string | undefined>;
  switch (kind) {
    case "dotenv":
      return c.path ?? "-";
    case "ssm":
      return [c.prefix, [c.region, c.profile && `프로필 ${c.profile}`].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
    case "vercel":
      return [`${c.project ?? "-"} (${c.target ?? "-"})`, c.scope && `scope ${c.scope}`, c.globalDir && `-Q ${c.globalDir}`].filter(Boolean).join(" · ");
    case "gha":
      return c.environment ? `${c.repo} · env ${c.environment}` : c.repo ?? "-";
    default:
      return "-";
  }
}

/** 기대 계정 한 줄 요약. */
export function accountSummary(kind: string, account: unknown): string {
  const a = (account ?? {}) as Record<string, string | undefined>;
  if (kind === "ssm") return a.accountId ? `AWS ${a.accountId}` : "-";
  if (kind === "vercel") return a.user ? `Vercel ${a.user}` : "-";
  if (kind === "gha") return a.login ? `GitHub ${a.login}` : "-";
  return "로컬 파일(계정 확인 없음)";
}

/** 운영 반영인가 — CLI 가 TTY 확인을 한 번 더 받는다. */
export function isProdTarget(env: string, kind: string, config: unknown): boolean {
  if (/prod/i.test(env)) return true;
  return kind === "vercel" && (config as { target?: string } | null)?.target === "production";
}

export type SyncState = "match" | "differs" | "never";
/** 금고 현재 값 지문 vs 대상에 마지막으로 반영한 지문. */
export function syncState(currentDigest: string, lastPushed: Record<string, string> | null | undefined, key: string): SyncState {
  const d = lastPushed?.[key];
  if (!d) return "never";
  return d === currentDigest ? "match" : "differs";
}

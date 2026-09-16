import { prisma } from "@/lib/prisma";

/**
 * 로그인 접근 제어.
 *
 * 세 가지 허용 경로를 함께 지원한다:
 *  (a) 초대 — `/api/members` 로 이메일 초대 시 User + status="invited" 멤버가 선생성되므로,
 *      해당 이메일의 invited/active 멤버십이 있으면 허용.
 *  (b) 도메인 — 이메일 도메인이 AUTH_ALLOWED_DOMAINS(콤마/공백 구분) 에 포함되면 허용.
 *  (c) 퍼블리시 게스트 — 살아 있는(active·미삭제) 퍼블리시 사이트의 SiteInvite 에 있는 이메일.
 *      멤버가 아니므로 볼 수 있는 건 /s/<slug> 뿐이다(워크스페이스는 requireCtx 가 막는다).
 *
 * AUTH_ALLOWED_DOMAINS 가 비어 있으면 (b)는 항상 불일치 → (a)·(c) 초대 전용 모드.
 * 하나라도 만족하면 로그인 허용.
 */

/** "a.com, @b.com  c.com" → ["a.com","b.com","c.com"] (소문자, 선행 @ 제거, 빈값 제거) */
export function parseAllowedDomains(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** 이메일의 도메인이 허용 목록과 정확히 일치하는지 (순수 함수, 대소문자 무시) */
export function emailDomainAllowed(
  email: string | null | undefined,
  domains: string[],
): boolean {
  if (!email || domains.length === 0) return false;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 && domains.includes(domain);
}

/**
 * 이 이메일의 로그인을 허용할지 결정한다. (a) 초대 또는 (b) 도메인 중 하나라도 만족하면 true.
 * prisma 접근이 필요하므로 노드 런타임(auth.ts signIn 콜백)에서만 호출한다.
 */
export async function isSignInAllowed(
  email: string | null | undefined,
): Promise<boolean> {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) return false;

  // (b) 도메인 허용
  if (
    emailDomainAllowed(
      normalized,
      parseAllowedDomains(process.env.AUTH_ALLOWED_DOMAINS),
    )
  ) {
    return true;
  }

  // (a) 초대/활성 멤버십 존재 (이메일 대소문자 무시)
  const member = await prisma.workspaceMember.findFirst({
    where: {
      status: { in: ["invited", "active"] },
      user: { is: { email: { equals: normalized, mode: "insensitive" } } },
    },
    select: { id: true },
  });
  if (member) return true;

  // (c) 퍼블리시 사이트 게스트 — 살아 있는 사이트의 초대 목록에 있는 이메일.
  //     이 경로로 들어온 사람은 멤버가 아니므로 워크스페이스 화면·API 는 requireCtx 가 막고,
  //     자동 가입도 canAutoJoinDefaultWorkspace 가 막는다. 볼 수 있는 건 /s/<slug> 뿐이다.
  const invite = await prisma.siteInvite.findFirst({
    where: { email: normalized, site: { is: { status: "active", deletedAt: null } } },
    select: { id: true },
  });
  return Boolean(invite);
}

/**
 * 멤버십 없는 로그인 사용자를 기본 워크스페이스에 자동 가입시켜도 되는가.
 *
 * 로그인 경로는 셋이다: (a) 초대 (b) 허용 도메인 (c) 퍼블리시 사이트 게스트.
 * (a) 는 이미 멤버 행이 있고, (c) 는 **멤버가 되면 안 되는** 사람이다.
 * 그래서 멤버 행 없이 들어온 사람 중 자동 가입 대상은 (b) 뿐이다.
 * 이 제한이 없으면 게스트가 워크스페이스 URL 을 여는 순간 editor 가 된다.
 */
export function canAutoJoinDefaultWorkspace(email: string | null | undefined): boolean {
  return emailDomainAllowed(email, parseAllowedDomains(process.env.AUTH_ALLOWED_DOMAINS));
}

/**
 * OAuth 가 이메일 소유를 확인했는가 — 같은 이메일의 기존 User 에 계정을 자동 연결해도 되는 전제.
 *
 * 초대(멤버·퍼블리시 게스트)는 User 행을 **로그인 전에** 만든다(또는 시드가 만든다). Auth.js 기본값은
 * 그런 행에 새 OAuth 계정을 붙이지 않고 OAuthAccountNotLinked 로 거부해서, 초대받은 사람의 첫 로그인이
 * "로그인 중 문제가 발생했어요"로 막혔다(2026-09-14 퍼블리시 게스트로 발견). 그래서 Google 에
 * allowDangerousEmailAccountLinking 을 켜고, 대신 **Google 이 확인한 이메일만** 통과시킨다 —
 * 이 앱의 권한은 전부 이메일 기준이므로 확인되지 않은 이메일로 연결되면 남의 초대를 가로챌 수 있다.
 */
export function isVerifiedOAuthEmail(
  provider: string | undefined,
  profile: { email_verified?: unknown } | undefined,
): boolean {
  if (provider !== "google") return true;
  return profile?.email_verified === true;
}

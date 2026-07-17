import { prisma } from "@/lib/prisma";

/**
 * 로그인 접근 제어.
 *
 * 두 가지 허용 경로를 함께 지원한다:
 *  (a) 초대 — `/api/members` 로 이메일 초대 시 User + status="invited" 멤버가 선생성되므로,
 *      해당 이메일의 invited/active 멤버십이 있으면 허용.
 *  (b) 도메인 — 이메일 도메인이 AUTH_ALLOWED_DOMAINS(콤마/공백 구분) 에 포함되면 허용.
 *
 * AUTH_ALLOWED_DOMAINS 가 비어 있으면 (b)는 항상 불일치 → 사실상 (a) 초대 전용 모드.
 * 둘 중 하나라도 만족하면 로그인 허용.
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
  return Boolean(member);
}

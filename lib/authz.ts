import type { Role } from "@/app/generated/prisma/enums";

/**
 * 역할 서열 (W1 RBAC): viewer(0) < editor(1) < admin(2).
 * - 모든 읽기(GET): viewer 이상
 * - 콘텐츠 쓰기: editor 이상
 * - 관리(멤버·팀·워크스페이스·슬랙·알림 규칙·에이전트 토큰): admin
 */
export const ROLE_ORDER: Record<Role, number> = {
  viewer: 0,
  editor: 1,
  admin: 2,
};

/** actual 역할이 required 이상인지. 알 수 없는 값은 항상 false(방어적). */
export function roleAtLeast(actual: Role, required: Role): boolean {
  const a = ROLE_ORDER[actual];
  const r = ROLE_ORDER[required];
  if (a === undefined || r === undefined) return false;
  return a >= r;
}

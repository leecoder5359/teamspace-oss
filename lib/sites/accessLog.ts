/* 퍼블리시 접근 이력(순수). 기록은 lib/sites/server.recordSiteAccess, 표시는 상세 화면 '접근 이력'.
   구분(kind)은 **지금** 기준이다: 지금 초대돼 있으면 invited, 멤버로 본 기록이 있으면 member,
   둘 다 아니면 revoked — 초대가 회수된 뒤에도 과거에 누가 봤는지는 남아 있어야 한다. */

export const ACCESS_DEDUPE_MS = 10 * 60 * 1000;

export type AccessRow = { email: string; member: boolean; version: number; createdAt: Date };
export type AccountAccess = {
  email: string;
  kind: "invited" | "member" | "revoked";
  count: number;
  firstAt: string;
  lastAt: string;
  recent: { at: string; version: number }[];
};

export function shouldRecordAccess(lastAt: Date | null, now = Date.now()): boolean {
  return !lastAt || now - lastAt.getTime() > ACCESS_DEDUPE_MS;
}

export function summarizeAccess(rows: AccessRow[], invitedEmails: string[], recentLimit = 20): AccountAccess[] {
  const invited = new Set(invitedEmails.map((e) => e.toLowerCase()));
  const byEmail = new Map<string, AccessRow[]>();
  for (const r of rows) {
    const list = byEmail.get(r.email) ?? [];
    list.push(r);
    byEmail.set(r.email, list);
  }
  return [...byEmail.entries()]
    .map(([email, list]) => {
      const sorted = [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const kind: AccountAccess["kind"] = invited.has(email) ? "invited" : sorted.some((r) => r.member) ? "member" : "revoked";
      return {
        email,
        kind,
        count: sorted.length,
        firstAt: sorted[sorted.length - 1].createdAt.toISOString(),
        lastAt: sorted[0].createdAt.toISOString(),
        recent: sorted.slice(0, recentLimit).map((r) => ({ at: r.createdAt.toISOString(), version: r.version })),
      };
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

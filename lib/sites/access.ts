/* 퍼블리시 사이트 접근 판정(순수). 규칙은 스펙 §3:
   살아 있는 사이트(미삭제·active)에 대해 초대 이메일 또는 워크스페이스 active 멤버만 ok.
   죽은 사이트는 멤버에게도 not_found — 존재를 흘리지 않는다. */

export type SiteVerdict = "ok" | "not_found" | "forbidden";
export type SiteForAccess = { status: "active" | "disabled"; deletedAt: Date | null };

export function canViewSite(i: {
  site: SiteForAccess | null;
  email: string | null;
  invited: boolean;
  member: boolean;
}): SiteVerdict {
  if (!i.site || i.site.deletedAt || i.site.status !== "active") return "not_found";
  if (!i.email) return "forbidden";
  return i.invited || i.member ? "ok" : "forbidden";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export function parseEmailList(input: string | string[]): { valid: string[]; invalid: string[] } {
  const parts = (Array.isArray(input) ? input : [input])
    .flatMap((s) => String(s).split(/[\s,;]+/))
    .filter(Boolean);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const e = normalizeEmail(p);
    if (!e) {
      if (!invalid.includes(p)) invalid.push(p);
    } else if (!valid.includes(e)) {
      valid.push(e);
    }
  }
  return { valid, invalid };
}

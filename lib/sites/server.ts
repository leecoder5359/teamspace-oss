import { prisma } from "@/lib/prisma";
import { canViewSite, normalizeEmail, type SiteVerdict } from "./access";
import { shouldRecordAccess } from "./accessLog";

/* 셸(/s/<slug>)과 /pub 가 공유하는 판정. requireCtx 를 쓰지 않는다 — 게스트는 멤버가 아니고,
   requireCtx 경로는 멤버십 해석(초대 수락·자동 가입)이라는 부수효과를 가진다. */

const SELECT = {
  id: true, slug: true, title: true, workspaceId: true, currentVersion: true, status: true, deletedAt: true, apiUpstream: true,
} as const;

export type SiteRow = {
  id: string; slug: string; title: string; workspaceId: string;
  currentVersion: number; status: "active" | "disabled"; deletedAt: Date | null;
  /** /pub/<token>/api/* 를 넘길 루프백 서버(lib/sites/apiProxy). null = 프록시 없음. */
  apiUpstream: string | null;
};
export type SiteAccess = { result: SiteVerdict; site: SiteRow | null; inviteId: string | null; member: boolean };

async function evaluate(site: SiteRow | null, rawEmail: string | null | undefined): Promise<SiteAccess> {
  if (!site) return { result: "not_found", site: null, inviteId: null, member: false };
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  const [invite, member] = email
    ? await Promise.all([
        prisma.siteInvite.findUnique({ where: { siteId_email: { siteId: site.id, email } }, select: { id: true } }),
        prisma.workspaceMember.findFirst({
          where: { workspaceId: site.workspaceId, status: "active", user: { is: { email: { equals: email, mode: "insensitive" } } } },
          select: { id: true },
        }),
      ])
    : [null, null];
  const result = canViewSite({ site, email, invited: Boolean(invite), member: Boolean(member) });
  return { result, site: result === "not_found" ? null : site, inviteId: invite?.id ?? null, member: Boolean(member) };
}

export async function siteAccessBySlug(slug: string, email: string | null | undefined): Promise<SiteAccess> {
  const site: SiteRow | null = await prisma.publishedSite.findUnique({ where: { slug }, select: SELECT });
  return evaluate(site, email);
}

export async function siteAccessById(id: string, email: string | null | undefined): Promise<SiteAccess> {
  const site: SiteRow | null = await prisma.publishedSite.findUnique({ where: { id }, select: SELECT });
  return evaluate(site, email);
}

/** 셸 열람 기록. 같은 계정이 ACCESS_DEDUPE_MS 안에 다시 열면 남기지 않는다(새로고침 소음). */
export async function recordSiteAccess(i: { siteId: string; email: string; member: boolean; version: number }): Promise<void> {
  const email = i.email.trim().toLowerCase();
  const last = await prisma.siteAccess.findFirst({
    where: { siteId: i.siteId, email },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!shouldRecordAccess(last?.createdAt ?? null)) return;
  await prisma.siteAccess.create({ data: { siteId: i.siteId, email, member: i.member, version: i.version } });
}

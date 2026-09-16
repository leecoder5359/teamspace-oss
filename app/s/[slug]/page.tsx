import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { siteAccessBySlug, recordSiteAccess } from "@/lib/sites/server";
import { signSiteToken } from "@/lib/sites/token";
import SiteFrame from "./SiteFrame";

/* =====================================================================
   /s/<slug> — 초대받은 게스트가 보는 셸.
   (ws) 레이아웃 밖이다: 게스트는 멤버가 아니므로 requireCtx/getPageContext 를 부르지 않는다.
   판정은 세션 이메일 × SiteInvite·멤버십(lib/sites/server). 통과하면 서명 토큰으로
   /pub 샌드박스 iframe 을 띄운다. 링크가 검색엔진·리퍼러로 새지 않게 noindex·no-referrer.
   ===================================================================== */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "공유된 페이지",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function SharedSitePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) redirect(`/login?callbackUrl=${encodeURIComponent(`/s/${slug}`)}`);

  const access = await siteAccessBySlug(slug, email);
  if (access.result === "not_found" || !access.site) notFound();

  const switchAccount = async () => {
    "use server";
    await signOut({ redirectTo: `/login?callbackUrl=${encodeURIComponent(`/s/${slug}`)}` });
  };

  if (access.result === "forbidden") {
    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: "24px 16px", background: "var(--surface-page, #f7f7f8)" }}>
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>이 페이지에 접근 권한이 없습니다</h1>
          <p style={{ fontSize: 14, color: "var(--text-muted, #666)", margin: "10px 0 18px" }}>
            지금 <b>{email}</b> 계정으로 로그인되어 있습니다. 초대받은 이메일 계정으로 다시 로그인하세요.
          </p>
          <form action={switchAccount}>
            <button type="submit" style={{ padding: "10px 16px", borderRadius: 9, border: "1px solid var(--border-default, #ddd)", background: "var(--surface-card, #fff)", fontSize: 14, cursor: "pointer" }}>
              다른 계정으로 로그인
            </button>
          </form>
        </div>
      </main>
    );
  }

  if (access.inviteId) {
    await prisma.siteInvite.update({ where: { id: access.inviteId }, data: { lastAccessAt: new Date() } }).catch(() => undefined);
  }
  // 접근 이력 — 기록 실패가 열람을 막지 않게 한다.
  await recordSiteAccess({ siteId: access.site.id, email, member: access.member, version: access.site.currentVersion }).catch(() => undefined);
  const token = signSiteToken({ siteId: access.site.id, version: access.site.currentVersion, email: email.toLowerCase() });

  return <SiteFrame title={access.site.title} email={email} src={`/pub/${token}/index.html`} onSwitch={switchAccount} />;
}

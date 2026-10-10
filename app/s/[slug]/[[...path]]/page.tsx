import type { Metadata } from "next";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { siteAccessBySlug, recordSiteAccess, currentSlugForAlias } from "@/lib/sites/server";
import { signSiteToken } from "@/lib/sites/token";
import { resolveShellFile, sitesRoot } from "@/lib/sites/store";
import { shellPath } from "@/lib/sites/shellPath";
import SiteFrame from "../SiteFrame";
import SiteAddressSync from "../SiteAddressSync";

/* =====================================================================
   /s/<slug>[/<하위 경로>] — 초대받은 게스트가 보는 셸.
   (ws) 레이아웃 밖이다: 게스트는 멤버가 아니므로 requireCtx/getPageContext 를 부르지 않는다.
   판정은 세션 이메일 × SiteInvite·멤버십(lib/sites/server). 통과하면 서명 토큰으로
   /pub 샌드박스 iframe 을 띄운다. 링크가 검색엔진·리퍼러로 새지 않게 noindex·no-referrer.

   하위 경로 → 파일: '' → index.html, 'a/b' → a/b.html → a/b/index.html (lib/sites/shellPath).
   옛 슬러그(별칭)로 오면 같은 하위 경로를 붙여 새 슬러그로 308 — 판정은 정식 주소에서 한다.
   iframe 안에서 이동하면 SiteAddressSync 가 주소창을 replaceState 로 맞춘다.
   ===================================================================== */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "공유된 페이지",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const FRAME_ID = "ts-site-frame";

function decodeAll(raw: string[]): string[] | null {
  try {
    return raw.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

export default async function SharedSitePage({ params }: { params: Promise<{ slug: string; path?: string[] }> }) {
  const { slug: rawSlug, path: rawPath } = await params;
  const decoded = decodeAll([rawSlug, ...(rawPath ?? [])]);
  if (!decoded) notFound();
  const [slug, ...segments] = decoded;
  const here = shellPath(slug, segments.join("/"));

  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email) redirect(`/login?callbackUrl=${encodeURIComponent(here)}`);

  const access = await siteAccessBySlug(slug, email);
  if (access.result === "not_found" || !access.site) {
    const current = await currentSlugForAlias(slug);
    if (current && current !== slug) permanentRedirect(shellPath(current, segments.join("/")));
    notFound();
  }

  const switchAccount = async () => {
    "use server";
    await signOut({ redirectTo: `/login?callbackUrl=${encodeURIComponent(here)}` });
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

  const site = access.site;
  const file = await resolveShellFile(sitesRoot(), site.id, site.currentVersion, segments);
  if (!file) notFound();

  if (access.inviteId) {
    await prisma.siteInvite.update({ where: { id: access.inviteId }, data: { lastAccessAt: new Date() } }).catch(() => undefined);
  }
  // 접근 이력 — 기록 실패가 열람을 막지 않게 한다.
  await recordSiteAccess({ siteId: site.id, email, member: access.member, version: site.currentVersion }).catch(() => undefined);
  const token = signSiteToken({ siteId: site.id, version: site.currentVersion, email: email.toLowerCase() });
  const src = `/pub/${token}/${file.split("/").map(encodeURIComponent).join("/")}`;

  return (
    <>
      <SiteFrame title={site.title} email={email} src={src} frameId={FRAME_ID} onSwitch={switchAccount} />
      <SiteAddressSync slug={site.slug} frameId={FRAME_ID} />
    </>
  );
}

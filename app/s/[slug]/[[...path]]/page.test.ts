import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

class Signal extends Error {
  constructor(public kind: string, public url?: string) {
    super(kind);
  }
}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Signal("notFound");
  },
  redirect: (url: string) => {
    throw new Signal("redirect", url);
  },
  permanentRedirect: (url: string) => {
    throw new Signal("permanentRedirect", url);
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { siteInvite: { update: vi.fn() } } }));
vi.mock("@/lib/sites/server", () => ({ siteAccessBySlug: vi.fn(), recordSiteAccess: vi.fn(), currentSlugForAlias: vi.fn() }));
vi.mock("@/lib/sites/store", () => ({ resolveShellFile: vi.fn(), sitesRoot: () => "/tmp/sites" }));
vi.mock("@/lib/sites/token", () => ({ signSiteToken: () => "TOK.SIG" }));
vi.mock("../SiteFrame", () => ({ default: function SiteFrame() { return null; } }));
vi.mock("../SiteAddressSync", () => ({ default: function SiteAddressSync() { return null; } }));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { siteAccessBySlug, recordSiteAccess, currentSlugForAlias } from "@/lib/sites/server";
import { resolveShellFile } from "@/lib/sites/store";
import SharedSitePage from "./page";

const m = (f: unknown) => f as Mock;
const run = (slug: string, path?: string[]) => SharedSitePage({ params: Promise.resolve({ slug, path }) });
async function signal(p: Promise<unknown>): Promise<Signal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Signal) return e;
    throw e;
  }
  throw new Error("신호 없음");
}

const site = { id: "cs1", slug: "banjang-handover", title: "T", workspaceId: "w1", currentVersion: 3, status: "active", deletedAt: null, apiUpstream: null };

type El = { props: { children: { props: Record<string, unknown> }[] } };

describe("/s/[slug]/[[...path]] 셸", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(auth).mockResolvedValue({ user: { email: "g@gmail.com" } });
    m(siteAccessBySlug).mockResolvedValue({ result: "ok", site, inviteId: "inv1", member: false });
    m(prisma.siteInvite.update).mockResolvedValue({});
    m(recordSiteAccess).mockResolvedValue(undefined);
  });

  it("비로그인 → 로그인, callbackUrl 에 하위 경로까지", async () => {
    m(auth).mockResolvedValue(null);
    const s = await signal(run("banjang-handover", ["pages", "supabase-setup"]));
    expect(s.kind).toBe("redirect");
    expect(s.url).toBe(`/login?callbackUrl=${encodeURIComponent("/s/banjang-handover/pages/supabase-setup")}`);
  });

  it("하위 경로 → 그 파일을 iframe src 로, 열람 기록·초대 lastAccessAt", async () => {
    m(resolveShellFile).mockResolvedValue("pages/supabase-setup.html");
    const el = (await run("banjang-handover", ["pages", "supabase-setup"])) as unknown as El;
    expect(resolveShellFile).toHaveBeenCalledWith("/tmp/sites", "cs1", 3, ["pages", "supabase-setup"]);
    const [frame, sync] = el.props.children;
    expect(frame.props.src).toBe("/pub/TOK.SIG/pages/supabase-setup.html");
    expect(sync.props.slug).toBe("banjang-handover");
    expect(sync.props.frameId).toBe(frame.props.frameId);
    expect(prisma.siteInvite.update).toHaveBeenCalled();
    expect(recordSiteAccess).toHaveBeenCalledWith({ siteId: "cs1", email: "g@gmail.com", member: false, version: 3 });
  });

  it("경로 없으면 index.html", async () => {
    m(resolveShellFile).mockResolvedValue("index.html");
    const el = (await run("banjang-handover")) as unknown as El;
    expect(resolveShellFile).toHaveBeenCalledWith("/tmp/sites", "cs1", 3, []);
    expect(el.props.children[0].props.src).toBe("/pub/TOK.SIG/index.html");
  });

  it("인코딩된 세그먼트는 풀어서 찾고, src 는 다시 인코딩", async () => {
    m(resolveShellFile).mockResolvedValue("pages/설정.html");
    const el = (await run("banjang-handover", ["pages", encodeURIComponent("설정")])) as unknown as El;
    expect(resolveShellFile).toHaveBeenCalledWith("/tmp/sites", "cs1", 3, ["pages", "설정"]);
    expect(el.props.children[0].props.src).toBe(`/pub/TOK.SIG/pages/${encodeURIComponent("설정")}.html`);
  });

  it("없는 파일·이탈 경로 → 404, 열람 기록 없음", async () => {
    m(resolveShellFile).mockResolvedValue(null);
    expect((await signal(run("banjang-handover", ["..", "x"]))).kind).toBe("notFound");
    expect(recordSiteAccess).not.toHaveBeenCalled();
  });

  it("깨진 퍼센트 인코딩 → 404", async () => {
    expect((await signal(run("banjang-handover", ["%E0%A4%A"]))).kind).toBe("notFound");
  });

  it("옛 슬러그(별칭) → 같은 하위 경로로 308, 판정은 새 주소에서", async () => {
    m(siteAccessBySlug).mockResolvedValue({ result: "not_found", site: null, inviteId: null, member: false });
    m(currentSlugForAlias).mockResolvedValue("banjang-handover");
    const s = await signal(run("OLDrandom123", ["pages", "x"]));
    expect(s.kind).toBe("permanentRedirect");
    expect(s.url).toBe("/s/banjang-handover/pages/x");
    expect(resolveShellFile).not.toHaveBeenCalled();
    expect(recordSiteAccess).not.toHaveBeenCalled();
  });

  it("사이트도 별칭도 없으면 404", async () => {
    m(siteAccessBySlug).mockResolvedValue({ result: "not_found", site: null, inviteId: null, member: false });
    m(currentSlugForAlias).mockResolvedValue(null);
    expect((await signal(run("nope-nope"))).kind).toBe("notFound");
  });

  it("권한 없음 → 안내 화면(파일 존재 여부를 보지 않는다)", async () => {
    m(siteAccessBySlug).mockResolvedValue({ result: "forbidden", site, inviteId: null, member: false });
    const el = await run("banjang-handover", ["pages", "x"]);
    expect(el).toBeTruthy();
    expect(resolveShellFile).not.toHaveBeenCalled();
    expect(recordSiteAccess).not.toHaveBeenCalled();
  });
});

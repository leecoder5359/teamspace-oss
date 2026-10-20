import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

class NotFoundSignal extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { findUnique: vi.fn() } } }));
vi.mock("@/lib/workspace", () => ({ getPageContext: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), pageAccess: vi.fn() }));
vi.mock("@/lib/pageService", () => ({ getPageContent: vi.fn() }));
vi.mock("@/components/PageView", () => ({ default: function PageView() { return null; } }));
vi.mock("@/components/DatabaseView", () => ({ default: function DatabaseView() { return null; } }));

import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";
import { loadAccess, pageAccess } from "@/lib/pageGuard";
import { getPageContent } from "@/lib/pageService";
import PageView from "@/components/PageView";
import DatabaseView from "@/components/DatabaseView";
import PagePage, { generateMetadata } from "./page";

const m = (f: unknown) => f as Mock;
const run = () => PagePage({ params: Promise.resolve({ id: "p1" }) });

describe("/p/[id] 페이지", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(getPageContext).mockResolvedValue({ workspaceId: "w1" });
    m(loadAccess).mockResolvedValue({});
  });

  it("행이 없으면 admin(edit 권한)이어도 404", async () => {
    m(pageAccess).mockReturnValue("edit");
    m(prisma.page.findUnique).mockResolvedValue(null);
    await expect(run()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("휴지통 문서는 404", async () => {
    m(pageAccess).mockReturnValue("edit");
    m(prisma.page.findUnique).mockResolvedValue({ kind: "doc", deletedAt: new Date(), workspaceId: "w1" });
    await expect(run()).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it("다른 워크스페이스 페이지는 404 — admin(edit 권한)이어도", async () => {
    m(pageAccess).mockReturnValue("edit");
    m(prisma.page.findUnique).mockResolvedValue({ kind: "doc", deletedAt: null, workspaceId: "w2" });
    await expect(run()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(m(prisma.page.findUnique).mock.calls[0][0].select).toMatchObject({ workspaceId: true });
  });

  it("접근 none 이면 DB 조회 전에 404", async () => {
    m(pageAccess).mockReturnValue("none");
    await expect(run()).rejects.toBeInstanceOf(NotFoundSignal);
    expect(prisma.page.findUnique).not.toHaveBeenCalled();
  });

  it("kind=database 는 DatabaseView", async () => {
    m(pageAccess).mockReturnValue("edit");
    m(prisma.page.findUnique).mockResolvedValue({ kind: "database", deletedAt: null, workspaceId: "w1" });
    const el = (await run()) as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(DatabaseView);
    expect(el.props.pageId).toBe("p1");
  });

  it("kind=doc 은 PageView(fileBacked)", async () => {
    m(pageAccess).mockReturnValue("view");
    m(prisma.page.findUnique).mockResolvedValue({ kind: "doc", deletedAt: null, workspaceId: "w1" });
    const el = (await run()) as { type: unknown; props: Record<string, unknown> };
    expect(el.type).toBe(PageView);
    expect(el.props).toMatchObject({ pageId: "p1", fileBacked: true });
  });

  it("doc 은 본문을 서버에서 같이 읽어 PageView 에 넘긴다(nonce 포함) — API 와 같은 getPageContent", async () => {
    m(pageAccess).mockReturnValue("view");
    m(prisma.page.findUnique).mockResolvedValue({ kind: "doc", deletedAt: null, workspaceId: "w1" });
    const page = { id: "p1", title: "T", icon: null, parentId: null, kind: "doc", rev: 7 };
    m(getPageContent).mockResolvedValue({ ok: true, page, markdown: "# hi" });
    const el = (await run()) as { type: unknown; props: { initial: { page: unknown; markdown: string; nonce: string } } };
    expect(m(getPageContent).mock.calls[0][1]).toBe("p1");
    expect(el.props.initial).toMatchObject({ page, markdown: "# hi" });
    expect(el.props.initial.nonce).toMatch(/.{8,}/);
  });

  it("본문 미리 읽기가 실패하면 initial=null — 편집기가 종전대로 API 로 받는다", async () => {
    m(pageAccess).mockReturnValue("view");
    m(prisma.page.findUnique).mockResolvedValue({ kind: "doc", deletedAt: null, workspaceId: "w1" });
    m(getPageContent).mockRejectedValue(new Error("fs"));
    const el = (await run()) as { type: unknown; props: { initial: unknown } };
    expect(el.type).toBe(PageView);
    expect(el.props.initial).toBeNull();
  });
});

describe("/p/[id] 탭 제목(U-16)", () => {
  const meta = () => generateMetadata({ params: Promise.resolve({ id: "p1" }) });
  beforeEach(() => {
    vi.resetAllMocks();
    m(getPageContext).mockResolvedValue({ workspaceId: "w1" });
    m(loadAccess).mockResolvedValue({});
  });

  it("볼 수 있는 문서는 문서 제목이 탭 제목", async () => {
    m(pageAccess).mockReturnValue("view");
    m(prisma.page.findUnique).mockResolvedValue({ title: "배포 가이드", deletedAt: null, workspaceId: "w1" });
    expect(await meta()).toEqual({ title: "배포 가이드" });
  });

  it("권한 없음·휴지통·다른 워크스페이스는 제목을 내보내지 않는다", async () => {
    m(pageAccess).mockReturnValue("none");
    expect(await meta()).toEqual({});
    expect(prisma.page.findUnique).not.toHaveBeenCalled();
    m(pageAccess).mockReturnValue("edit");
    m(prisma.page.findUnique).mockResolvedValue({ title: "비밀", deletedAt: new Date(), workspaceId: "w1" });
    expect(await meta()).toEqual({});
    m(prisma.page.findUnique).mockResolvedValue({ title: "비밀", deletedAt: null, workspaceId: "w2" });
    expect(await meta()).toEqual({});
  });

  it("제목이 비면 '제목 없음'", async () => {
    m(pageAccess).mockReturnValue("view");
    m(prisma.page.findUnique).mockResolvedValue({ title: "", deletedAt: null, workspaceId: "w1" });
    expect(await meta()).toEqual({ title: "제목 없음" });
  });
});

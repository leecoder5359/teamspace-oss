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
vi.mock("@/components/PageView", () => ({ default: function PageView() { return null; } }));
vi.mock("@/components/DatabaseView", () => ({ default: function DatabaseView() { return null; } }));

import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";
import { loadAccess, pageAccess } from "@/lib/pageGuard";
import PageView from "@/components/PageView";
import DatabaseView from "@/components/DatabaseView";
import PagePage from "./page";

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
});

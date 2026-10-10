import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findFirst: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), pageAccess: vi.fn(), projectAccess: vi.fn() }));
vi.mock("@/lib/notify", () => ({ fireNotif: vi.fn() }));
vi.mock("@/lib/digest", async (orig) => ({
  ...(await orig<typeof import("@/lib/digest")>()),
  collectDigest: vi.fn(),
  channelCanSee: vi.fn(async () => () => true),
  excludeArchived: vi.fn(async (_w: string, f: (id: string) => boolean) => f),
}));

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { pageAccess, projectAccess } from "@/lib/pageGuard";
import { fireNotif } from "@/lib/notify";
import { collectDigest, channelCanSee } from "@/lib/digest";
import { GET, POST } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = (role: string) => ({ workspaceId: "w1", userId: "u1", role, actor: { type: "user", id: "u1", name: "U" } });
const digest = (n = 1) => ({
  project: { id: "p1", name: "TeamSpace" },
  range: { since: "2026-10-02T00:00:00.000Z", until: "2026-10-09T00:00:00.000Z" },
  tasksDone: Array.from({ length: n }, () => ({ title: "일", boardTitle: "보드" })),
  decisions: [],
  lessons: [],
  docs: { created: 0, updated: 0, titles: [] },
  approvals: { approved: 0, rejected: 0, pending: 0 },
});
const get = (q: string) => GET(new Request(`http://t/api/digest${q}`));
const post = (body: unknown) => POST(new Request("http://t/api/digest", { method: "POST", body: JSON.stringify(body) }));

describe("GET /api/digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(ctx("editor"));
    m(projectAccess).mockReturnValue("view");
    m(collectDigest).mockResolvedValue(digest());
  });

  it("editor 이상 — viewer 는 requireCtx 가 거절", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 403 }) });
    expect((await get("?project=p1")).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("editor");
    expect(collectDigest).not.toHaveBeenCalled();
  });

  it("digest·markdown 을 돌려주고, 기본 7일·요청자 색인으로 페이지를 거른다", async () => {
    m(pageAccess).mockImplementation((_i: unknown, id: string) => (id === "locked" ? "none" : "view"));
    const res = await get("?project=p1");
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.digest.project.name).toBe("TeamSpace");
    expect(j.markdown).toContain("# TeamSpace 주간 다이제스트");
    const opts = m(collectDigest).mock.calls[0][1];
    expect(opts).toMatchObject({ workspaceId: "w1", projectId: "p1" });
    expect(opts.until.getTime() - opts.since.getTime()).toBe(7 * 86_400_000);
    expect(opts.canSee("locked")).toBe(false);
    expect(opts.canSee("open")).toBe(true);
  });

  it("볼 수 없는 프로젝트는 404(D3), 없는 프로젝트도 404", async () => {
    m(projectAccess).mockReturnValue("none");
    expect((await get("?project=p1")).status).toBe(404);
    expect(collectDigest).not.toHaveBeenCalled();
    m(projectAccess).mockReturnValue("view");
    m(collectDigest).mockResolvedValue(null);
    expect((await get("?project=nope")).status).toBe(404);
  });

  it("week=1 이면 지난주(Asia/Seoul 월~일) 창", async () => {
    await get("?project=p1&week=1");
    const c = m(collectDigest).mock.calls[0][1];
    expect(c.until.getTime() - c.since.getTime()).toBe(7 * 86_400_000);
    expect(c.since.getUTCHours()).toBe(15);
    expect(c.since.getUTCMinutes()).toBe(0);
  });

  it("project 누락·days 범위 밖·week 잘못된 값은 400", async () => {
    expect((await get("?project=p1&week=yes")).status).toBe(400);
    expect((await get("")).status).toBe(400);
    expect((await get("?project=p1&days=0")).status).toBe(400);
    expect((await get("?project=p1&days=32")).status).toBe(400);
  });
});

describe("POST /api/digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(ctx("admin"));
    m(prisma.project.findFirst).mockResolvedValue({ visibility: "inherit" });
    m(collectDigest).mockResolvedValue(digest());
    m(fireNotif).mockResolvedValue({ delivered: 1, failed: 0 });
  });

  it("admin 전용", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 403 }) });
    expect((await post({ projectId: "p1", send: true })).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("admin");
    expect(fireNotif).not.toHaveBeenCalled();
  });

  it("fireNotif(weekly_digest) 로 발송(규칙 → 기본 채널 폴백) — 채널용 가시성으로 거른다", async () => {
    const j = await (await post({ projectId: "p1", send: true, days: 3 })).json();
    expect(j).toEqual({ sent: true, channels: 1 });
    expect(channelCanSee).toHaveBeenCalledWith("w1");
    const [wsId, event, text, projectId, opts] = m(fireNotif).mock.calls[0];
    expect([wsId, event, projectId, opts]).toEqual(["w1", "weekly_digest", "p1", { kind: "digest", fallbackToDefault: true }]);
    expect(text).toContain("*TeamSpace* 주간 다이제스트");
    const c = m(collectDigest).mock.calls[0][1];
    expect(c.until.getTime() - c.since.getTime()).toBe(3 * 86_400_000);
  });

  it("week:true 면 지난주 월 00:00 ~ 월 00:00(Asia/Seoul) — days 무시", async () => {
    await post({ projectId: "p1", send: true, week: true, days: 3 });
    const c = m(collectDigest).mock.calls[0][1];
    expect(c.until.getTime() - c.since.getTime()).toBe(7 * 86_400_000);
    // KST 자정 = UTC 15:00
    expect(c.since.getUTCHours()).toBe(15);
    expect(c.until.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("send:true 없거나 projectId 없으면 400", async () => {
    expect((await post({ projectId: "p1" })).status).toBe(400);
    expect((await post({ send: true })).status).toBe(400);
  });

  it("다른 워크스페이스 프로젝트 404, 잠긴 프로젝트 409", async () => {
    m(prisma.project.findFirst).mockResolvedValue(null);
    expect((await post({ projectId: "p1", send: true })).status).toBe(404);
    expect(m(prisma.project.findFirst).mock.calls[0][0].where).toEqual({ id: "p1", workspaceId: "w1" });
    m(prisma.project.findFirst).mockResolvedValue({ visibility: "restricted" });
    expect((await post({ projectId: "p1", send: true })).status).toBe(409);
    expect(fireNotif).not.toHaveBeenCalled();
  });

  it("활동 0건이면 보내지 않음, Slack 실패는 sent:false + error", async () => {
    m(collectDigest).mockResolvedValue(digest(0));
    expect(await (await post({ projectId: "p1", send: true })).json()).toEqual({ sent: false, reason: "empty" });
    expect(fireNotif).not.toHaveBeenCalled();
    m(collectDigest).mockResolvedValue(digest(1));
    m(fireNotif).mockResolvedValue({ delivered: 0, failed: 0, noTarget: true, error: "not_connected" });
    expect(await (await post({ projectId: "p1", send: true })).json()).toEqual({ sent: false, channels: 0, error: "not_connected" });
    m(fireNotif).mockResolvedValue({ delivered: 1, failed: 1, error: "is_archived" });
    expect(await (await post({ projectId: "p1", send: true })).json()).toEqual({ sent: false, channels: 1, error: "is_archived" });
    m(fireNotif).mockResolvedValue({ delivered: 0, failed: 0, noTarget: true });
    expect(await (await post({ projectId: "p1", send: true })).json()).toEqual({ sent: false, channels: 0, error: "no_channel" });
  });
});

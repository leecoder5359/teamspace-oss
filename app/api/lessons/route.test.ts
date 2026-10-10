import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { lesson: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() }, project: { findUnique: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET, POST } from "./route";

const m = (f: unknown) => f as Mock;
const get = (qs = "") => GET(new Request(`http://t/api/lessons${qs}`));

describe("GET /api/lessons", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer", personId: "u1" });
    m(prisma.lesson.findMany).mockResolvedValue([{ id: "l1", title: "배포 규칙" }]);
    m(prisma.lesson.count).mockResolvedValue(7);
  });

  it("q 는 제목 부분일치(대소문자 무시)로 where 에 실린다", async () => {
    await get("?q=%20%EB%B0%B0%ED%8F%AC%20");
    const { where } = m(prisma.lesson.findMany).mock.calls[0][0];
    expect(where).toEqual({
      workspaceId: "w1",
      AND: [{ OR: [{ userId: null }, { userId: "u1" }] }],
      title: { contains: "배포", mode: "insensitive" },
    });
  });

  it("limit 은 1..300 으로 맞춰 take 에 실리고, 생략하면 take 가 없다", async () => {
    await get("?limit=9999");
    expect(m(prisma.lesson.findMany).mock.calls[0][0].take).toBe(300);
    await get("?limit=0");
    expect(m(prisma.lesson.findMany).mock.calls[1][0].take).toBe(1);
    await get();
    expect(m(prisma.lesson.findMany).mock.calls[2][0]).not.toHaveProperty("take");
  });

  it("total 은 limit 앞의 건수(count)이고 같은 where 를 쓴다", async () => {
    const j = await (await get("?q=a&limit=1")).json();
    expect(j).toEqual({ lessons: [{ id: "l1", title: "배포 규칙", scope: "global", personal: false, mode: "default" }], total: 7 });
    expect(m(prisma.lesson.count).mock.calls[0][0].where).toEqual(m(prisma.lesson.findMany).mock.calls[0][0].where);
  });

  it("projectId 는 전역(null)과 해당 프로젝트를 함께 낸다", async () => {
    await get("?projectId=p1");
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where.OR).toEqual([{ projectId: "p1" }, { projectId: null }]);
  });
});

describe("GET /api/lessons — 개인 레슨 가시성·mode", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.lesson.findMany).mockResolvedValue([]);
    m(prisma.lesson.count).mockResolvedValue(0);
  });

  it("에이전트 토큰은 발급자의 개인 레슨만, 발급자를 모르면 개인 레슨은 하나도", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "a" }, personId: "human1" });
    await get();
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where.AND).toEqual([{ OR: [{ userId: null }, { userId: "human1" }] }]);
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "a" }, personId: null });
    await get();
    expect(m(prisma.lesson.findMany).mock.calls[1][0].where.AND).toEqual([{ OR: [{ userId: null }] }]);
  });

  it("admin 은 관리용으로 모든 개인 레슨을 본다", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "admin", personId: "u1" });
    await get();
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where).not.toHaveProperty("AND");
  });

  it("mode 로 거르고, 모르는 mode 는 400", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer", personId: "u1" });
    await get("?mode=ondemand");
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where.mode).toBe("ondemand");
    expect((await get("?mode=always")).status).toBe(400);
  });

  it("응답의 scope·personal", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer", personId: "u1" });
    m(prisma.lesson.findMany).mockResolvedValue([
      { id: "a", projectId: null, stack: null, userId: "u1", mode: "required" },
      { id: "b", projectId: "p", stack: null, userId: null, mode: "default" },
      { id: "c", projectId: null, stack: "next", userId: null, mode: "ondemand" },
    ]);
    const j = await (await get()).json();
    expect(j.lessons.map((l: { scope: string; personal: boolean; mode: string }) => [l.scope, l.personal, l.mode])).toEqual([
      ["personal", true, "required"],
      ["project", false, "default"],
      ["stack", false, "ondemand"],
    ]);
  });
});

describe("POST /api/lessons — personal·mode", () => {
  const post = (body: unknown) => POST(new Request("http://t/api/lessons", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const base = { title: "습관", body: "처방: 이렇게" };
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "a" }, personId: "human1" });
    m(prisma.project.findUnique).mockResolvedValue({ workspaceId: "w1" });
    m(prisma.lesson.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new", stack: null, mode: "default", ...data }));
  });

  it("personal:true → userId = 요청한 사람(토큰이면 발급자), 응답 scope=personal", async () => {
    const res = await post({ ...base, personal: true, mode: "required" });
    expect(res.status).toBe(200);
    const data = m(prisma.lesson.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ userId: "human1", projectId: null, stack: null, mode: "required", createdById: "agentU" });
    expect((await res.json()).lesson).toMatchObject({ scope: "personal", personal: true, mode: "required" });
  });

  it("personal 을 projectId·stack 과 함께 주면 400", async () => {
    expect((await post({ ...base, personal: true, projectId: "p1" })).status).toBe(400);
    expect((await post({ ...base, personal: true, stack: "next" })).status).toBe(400);
    expect(prisma.lesson.create).not.toHaveBeenCalled();
  });

  it("사람을 모르면(발급자 미상 토큰) personal 은 400", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "a" }, personId: null });
    const res = await post({ ...base, personal: true });
    expect(res.status).toBe(400);
    expect(prisma.lesson.create).not.toHaveBeenCalled();
  });

  it("모르는 mode 는 400, 생략하면 mode 를 넣지 않는다(DB 기본 default)·개인 아님", async () => {
    expect((await post({ ...base, mode: "always" })).status).toBe(400);
    await post(base);
    const data = m(prisma.lesson.create).mock.calls[0][0].data;
    expect(data).not.toHaveProperty("mode");
    expect(data.userId).toBeNull();
  });
});

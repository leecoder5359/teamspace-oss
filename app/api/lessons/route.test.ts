import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lesson: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
    project: { findUnique: vi.fn() },
    workspaceMember: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    idempotencyRecord: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

import { requireCtx } from "@/lib/workspace";
import { invalidateGraphCache } from "@/lib/graphLoad";
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

  it("팀 레슨 생성은 그래프 캐시를 비우고, 개인 레슨(그래프에 없음)은 비우지 않는다(리뷰 I-1)", async () => {
    expect((await post(base)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
    m(invalidateGraphCache).mockClear();
    expect((await post({ ...base, personal: true })).status).toBe(200);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
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

  it("keywords 는 소문자·중복 제거로 저장, 생략하면 넣지 않고, 1자 키워드는 400", async () => {
    await post({ ...base, keywords: "Prisma, 마이그레이션 ,prisma" });
    expect(m(prisma.lesson.create).mock.calls[0][0].data.keywords).toEqual(["prisma", "마이그레이션"]);
    await post({ ...base, keywords: ["반장", "BANJANG"] });
    expect(m(prisma.lesson.create).mock.calls[1][0].data.keywords).toEqual(["반장", "banjang"]);
    await post(base);
    expect(m(prisma.lesson.create).mock.calls[2][0].data).not.toHaveProperty("keywords");
    expect((await post({ ...base, keywords: "a" })).status).toBe(400);
  });
});

describe("GET /api/lessons?scope=", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.lesson.count).mockResolvedValue(0);
  });

  it("모르는 scope 는 400", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", personId: "u1" });
    expect((await get("?scope=all")).status).toBe(400);
  });

  it("teammates 는 editor 이상을 요구한다", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    expect((await get("?scope=teammates")).status).toBe(403);
    expect(m(requireCtx).mock.calls[0][0]).toBe("editor");
  });

  it("teammates = 활성 멤버 중 나를 뺀 사람의 공개 개인 레슨(복사본 제외) + 작성자·copiedId", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "me", role: "admin", personId: "me" });
    m(prisma.workspaceMember.findMany).mockResolvedValue([
      { userId: "me", user: { name: "나", email: "me@x" } },
      { userId: "b", user: { name: null, email: "bee@x" } },
    ]);
    m(prisma.lesson.findMany)
      .mockResolvedValueOnce([{ id: "T1", userId: "b", projectId: null, stack: null, mode: "default", title: "t", body: "b" }])
      .mockResolvedValueOnce([{ id: "C1", copiedFromId: "T1" }]);
    const j = await (await get("?scope=teammates")).json();
    expect(m(prisma.workspaceMember.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", status: "active" });
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where).toEqual({
      workspaceId: "w1",
      AND: [{ userId: { in: ["b"] }, sharedWithTeam: true, copiedFromId: null }],
    });
    expect(j.lessons[0]).toMatchObject({ id: "T1", author: { id: "b", name: "bee" }, copiedId: "C1", personal: true });
  });

  it("teammates — 사람을 모르는 토큰은 빈 목록", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "a" }, personId: null });
    m(prisma.workspaceMember.findMany).mockResolvedValue([]);
    expect(await (await get("?scope=teammates")).json()).toEqual({ lessons: [], total: 0 });
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
  });

  it("mine = admin 이어도 내 것만 + copiedFrom(원본 삭제됨)", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "boss", role: "admin", personId: "boss" });
    m(prisma.lesson.findMany)
      .mockResolvedValueOnce([{ id: "L1", userId: "boss", projectId: null, copiedFromId: "GONE" }])
      .mockResolvedValueOnce([]); // 원본 조회 — 없음
    const j = await (await get("?scope=mine")).json();
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", AND: [{ userId: "boss" }] });
    expect(j.lessons[0].copiedFrom).toEqual({ id: "GONE", authorName: null, deleted: true });
  });

  it("team = 개인 레슨 제외(admin 이라도)", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "boss", role: "admin", personId: "boss" });
    m(prisma.lesson.findMany).mockResolvedValue([]);
    await get("?scope=team");
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", AND: [{ userId: null }] });
  });
});

describe("POST /api/lessons — Idempotency-Key", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "u1" }, personId: "u1" });
    m(prisma.lesson.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "N1", projectId: null, ...data }));
  });
  const post = (body: unknown, key?: string) =>
    POST(new Request("http://t/api/lessons", { method: "POST", body: JSON.stringify(body), headers: key ? { "idempotency-key": key } : {} }));

  it("같은 키의 재요청은 저장된 응답을 돌려주고 새로 만들지 않는다", async () => {
    m(prisma.idempotencyRecord.findUnique).mockResolvedValue({ response: { lesson: { id: "OLD" } } });
    const res = await post({ title: "t", body: "b", personal: true }, "feedback-reply-in-korean");
    expect(res.headers.get("x-idempotent-replay")).toBe("1");
    expect((await res.json()).lesson.id).toBe("OLD");
    expect(prisma.lesson.create).not.toHaveBeenCalled();
  });

  it("키가 없으면 종전처럼 바로 만든다", async () => {
    const res = await post({ title: "t", body: "b" });
    expect(res.status).toBe(200);
    expect(prisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
  });
});

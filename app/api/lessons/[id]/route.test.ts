import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { lesson: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() } } }));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn(async (id: string | null) => ({ ok: true, projectId: id || null })) }));
vi.mock("@/lib/lessonInspect/log", () => ({ recordLessonRead: vi.fn(async () => undefined) }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET, PATCH, DELETE } from "./route";

const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "L1" }) };
const get = () => GET(new Request("http://t/api/lessons/L1"), params);
const patch = (body: unknown) => PATCH(new Request("http://t/api/lessons/L1", { method: "PATCH", body: JSON.stringify(body) }), params);
const del = () => DELETE(new Request("http://t/api/lessons/L1", { method: "DELETE" }), params);

const lesson = (extra: Record<string, unknown> = {}) => ({ id: "L1", workspaceId: "w1", title: "t", body: "b", projectId: null, stack: null, userId: null, mode: "default", ...extra });
const human = (id: string, role = "editor") => ({ workspaceId: "w1", userId: id, role, actor: { type: "user", id, name: id }, personId: id });

beforeEach(() => {
  vi.resetAllMocks();
  m(prisma.lesson.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => lesson(data));
  m(prisma.lesson.delete).mockResolvedValue({});
});

describe("/api/lessons/[id] — 개인 레슨 접근", () => {
  it("다른 사람의 개인 레슨은 조회·수정·삭제 모두 404, 본인은 된다", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ userId: "owner" }));
    m(requireCtx).mockResolvedValue(human("other"));
    expect((await get()).status).toBe(404);
    expect((await patch({ title: "x" })).status).toBe(404);
    expect((await del()).status).toBe(404);
    expect(prisma.lesson.update).not.toHaveBeenCalled();
    expect(prisma.lesson.delete).not.toHaveBeenCalled();

    m(requireCtx).mockResolvedValue(human("owner"));
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).lesson).toMatchObject({ scope: "personal", personal: true, mode: "default" });
  });

  it("에이전트 토큰은 발급자의 개인 레슨을 읽는다", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ userId: "owner" }));
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "a" }, personId: "owner" });
    expect((await get()).status).toBe(200);
  });

  it("admin 은 관리용으로 다른 사람의 개인 레슨을 읽을 수 있다", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ userId: "owner" }));
    m(requireCtx).mockResolvedValue(human("boss", "admin"));
    expect((await get()).status).toBe(200);
  });
});

describe("PATCH /api/lessons/[id] — personal·mode", () => {
  beforeEach(() => {
    m(requireCtx).mockResolvedValue(human("me"));
  });

  it("personal:true → userId=나, 프로젝트·스택을 비운다", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ projectId: "p1" }));
    const res = await patch({ personal: true });
    expect(res.status).toBe(200);
    expect(m(prisma.lesson.update).mock.calls[0][0].data).toEqual({ userId: "me", projectId: null, stack: null });
  });

  it("personal:true 를 projectId·stack 과 함께 주면 400", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson());
    expect((await patch({ personal: true, projectId: "p1" })).status).toBe(400);
    expect((await patch({ personal: true, stack: "next" })).status).toBe(400);
    expect(prisma.lesson.update).not.toHaveBeenCalled();
  });

  it("개인 레슨에 프로젝트를 정하면 개인이 풀린다, personal:false 는 전역으로", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ userId: "me" }));
    await patch({ projectId: "p1" });
    expect(m(prisma.lesson.update).mock.calls[0][0].data).toEqual({ projectId: "p1", stack: null, userId: null });
    await patch({ personal: false });
    expect(m(prisma.lesson.update).mock.calls[1][0].data).toEqual({ userId: null });
  });

  it("mode 변경, 모르는 값은 400", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson());
    await patch({ mode: "ondemand" });
    expect(m(prisma.lesson.update).mock.calls[0][0].data).toEqual({ mode: "ondemand" });
    expect((await patch({ mode: "sometimes" })).status).toBe(400);
  });

  it("사람을 모르는 토큰은 personal:true 를 400", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "a" }, personId: null });
    m(prisma.lesson.findUnique).mockResolvedValue(lesson());
    expect((await patch({ personal: true })).status).toBe(400);
  });
});

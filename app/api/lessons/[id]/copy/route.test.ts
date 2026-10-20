import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lesson: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    workspaceMember: { findUnique: vi.fn() },
  },
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const call = () => POST(new Request("http://t/api/lessons/S1/copy", { method: "POST" }), { params: Promise.resolve({ id: "S1" }) });
const src = (x: Record<string, unknown> = {}) => ({
  id: "S1", workspaceId: "w1", userId: "b", sharedWithTeam: true, copiedFromId: null, projectId: null, stack: null,
  mode: "ondemand", keywords: ["prisma"], title: "원본", body: "본문", ...x,
});

beforeEach(() => {
  vi.resetAllMocks();
  m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "me", role: "editor", actor: { type: "user", id: "me", name: "me" }, personId: "me" });
  m(prisma.workspaceMember.findUnique).mockResolvedValue({ status: "active" });
  m(prisma.lesson.findFirst).mockResolvedValue(null);
  m(prisma.lesson.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "NEW", projectId: null, stack: null, ...data }));
});

describe("POST /api/lessons/[id]/copy", () => {
  it("title·body·mode·keywords 를 복사한 내 개인 레슨(copiedFromId=원본)", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(src());
    const res = await call();
    expect(res.status).toBe(200);
    expect(m(requireCtx).mock.calls[0][0]).toBe("editor");
    expect(m(prisma.lesson.create).mock.calls[0][0].data).toEqual({
      workspaceId: "w1", userId: "me", copiedFromId: "S1", title: "원본", body: "본문",
      mode: "ondemand", keywords: ["prisma"], createdById: "me",
    });
    expect((await res.json()).lesson).toMatchObject({ id: "NEW", personal: true });
  });

  it("이미 가져왔으면 409 + 기존 id", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(src());
    m(prisma.lesson.findFirst).mockResolvedValue({ id: "EXIST" });
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ lessonId: "EXIST" });
    expect(prisma.lesson.create).not.toHaveBeenCalled();
  });

  it("동시 요청이 unique 에 걸리면(P2002) 409", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(src());
    m(prisma.lesson.findFirst).mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "RACE" });
    m(prisma.lesson.create).mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ lessonId: "RACE" });
  });

  it("비공개·작성자 비활성·가져온 복사본·다른 워크스페이스는 404 (admin 도)", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(src({ sharedWithTeam: false }));
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "boss", role: "admin", personId: "boss" });
    expect((await call()).status).toBe(404);
    m(prisma.lesson.findUnique).mockResolvedValue(src({ copiedFromId: "ORIG" }));
    expect((await call()).status).toBe(404);
    m(prisma.lesson.findUnique).mockResolvedValue(src());
    m(prisma.workspaceMember.findUnique).mockResolvedValue({ status: "removed" });
    expect((await call()).status).toBe(404);
    m(prisma.lesson.findUnique).mockResolvedValue(src({ workspaceId: "w2" }));
    expect((await call()).status).toBe(404);
    expect(prisma.lesson.create).not.toHaveBeenCalled();
  });

  it("내 레슨·팀 레슨은 400", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(src({ userId: "me" }));
    expect((await call()).status).toBe(400);
    m(prisma.lesson.findUnique).mockResolvedValue(src({ userId: null }));
    expect((await call()).status).toBe(400);
  });
});

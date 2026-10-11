import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), projectAccess: vi.fn(() => "view") }));
vi.mock("@/lib/lessonInspect/log", () => ({ recordLessonInjection: vi.fn(async () => undefined) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findMany: vi.fn() },
    workspaceRouteRule: { findMany: vi.fn() },
    lesson: { findMany: vi.fn() },
  },
}));

import { requireCtx } from "@/lib/workspace";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { recordLessonInjection } from "@/lib/lessonInspect/log";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const post = (body: unknown) => POST(new Request("http://t/api/context/prompt", { method: "POST", body: JSON.stringify(body) }));
const L = (id: string, o: Record<string, unknown> = {}) => ({ id, title: `레슨 ${id}`, body: `처방: ${id}`, projectId: null, stack: null, userId: null, mode: "ondemand", keywords: [], updatedAt: new Date(0), ...o });

describe("POST /api/context/prompt", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "memory-bridge" }, personId: "human1" });
    m(prisma.project.findMany).mockResolvedValue([
      { id: "bj", name: "반장", aliases: ["banjang"], stack: [], visibility: "inherit" },
      { id: "ts", name: "TeamSpace", aliases: [], stack: [], visibility: "inherit" },
    ]);
    m(prisma.workspaceRouteRule.findMany).mockResolvedValue([{ cwdPrefix: "/r/teamspace", workspaceId: "w1", projectId: "ts", priority: 0 }]);
    m(prisma.lesson.findMany).mockResolvedValue([L("g1", { keywords: ["prisma", "스키마"] }), L("bj1", { projectId: "bj", keywords: ["도면"] })]);
    m(recordLessonInjection).mockResolvedValue(undefined);
  });

  it("키워드·언급 프로젝트로 고르고 id 만 기록한다 — 프롬프트 원문은 기록에 없다", async () => {
    const prompt = "반장 도면이랑 prisma 스키마 비밀 문구 XYZZY 손보자";
    const res = await post({ prompt, cwd: "/r/teamspace/app", sessionId: "s1", exclude: [] });
    const j = await res.json();
    expect(j.lessonIds.sort()).toEqual(["bj1", "g1"]);
    expect(j.projectIds).toEqual(["bj"]);
    expect(j.markdown).toContain("`bj1`");
    const rec = m(recordLessonInjection).mock.calls[0][0];
    expect(rec).toMatchObject({ workspaceId: "w1", via: "UserPromptSubmit", mode: "prompt", projectId: "ts", cwd: "/r/teamspace/app", actorName: "memory-bridge" });
    expect(rec.ids.gistIds.sort()).toEqual(["bj1", "g1"]);
    expect(JSON.stringify(rec)).not.toContain("XYZZY");
  });

  it("lesson 조회는 필수 제외·내 개인 레슨만·볼 수 있는 프로젝트만", async () => {
    await post({ prompt: "prisma 손보자 지금" });
    const where = m(prisma.lesson.findMany).mock.calls[0][0].where;
    expect(where.mode).toEqual({ in: ["default", "ondemand"] });
    expect(where.AND[0]).toEqual({ OR: [{ userId: null }, { userId: "human1" }] });
    expect(where.AND[1]).toEqual({ OR: [{ projectId: null }, { projectId: { in: ["bj", "ts"] } }] });
    // cwd 가 없으면 route-rule 을 읽지 않는다
    expect(prisma.workspaceRouteRule.findMany).not.toHaveBeenCalled();
  });

  it("짧은 메시지·대상 없음 → 빈 markdown, 기록 없음", async () => {
    expect(await (await post({ prompt: "ㅇㅇ" })).json()).toEqual({ markdown: "", lessonIds: [], projectIds: [] });
    expect(await (await post({ prompt: "ㅇㅇ", preview: true })).json()).toEqual({ markdown: "", lessonIds: [], projectIds: [], matches: [] });
    expect(prisma.lesson.findMany).not.toHaveBeenCalled();
    const j = await (await post({ prompt: "오늘 날씨가 참 좋네요" })).json();
    expect(j.markdown).toBe("");
    expect(recordLessonInjection).not.toHaveBeenCalled();
  });

  it("preview 는 기록하지 않고 matches(사유·키워드)를 준다", async () => {
    const j = await (await post({ prompt: "반장 도면이랑 prisma 스키마 손보자", cwd: "/r/teamspace", preview: true })).json();
    expect(recordLessonInjection).not.toHaveBeenCalled();
    expect(j.cwdProjectId).toBe("ts");
    expect(j.matches).toEqual(
      expect.arrayContaining([
        { id: "g1", title: "레슨 g1", reason: "keyword", hits: ["prisma", "스키마"], shown: true },
        { id: "bj1", title: "레슨 bj1", reason: "keyword", hits: ["도면"], shown: true },
      ]),
    );
  });

  it("exclude 는 다시 넣지 않는다", async () => {
    const j = await (await post({ prompt: "반장 도면이랑 prisma 스키마 손보자", exclude: ["g1"] })).json();
    expect(j.lessonIds).toEqual(["bj1"]);
  });

  it("제한 프로젝트는 볼 수 없으면 언급해도 열리지 않는다", async () => {
    m(prisma.project.findMany).mockResolvedValue([{ id: "bj", name: "반장", aliases: [], stack: [], visibility: "restricted" }]);
    m(projectAccess).mockReturnValue("none");
    const j = await (await post({ prompt: "반장 도면 작업 하자" })).json();
    expect(loadAccess).toHaveBeenCalled();
    expect(j.projectIds).toEqual([]);
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where.AND[1]).toEqual({ OR: [{ projectId: null }, { projectId: { in: [] } }] });
  });

  it("본문 검증 실패는 400, 인증 실패는 그대로", async () => {
    expect((await post({ cwd: "/x" })).status).toBe(400);
    m(requireCtx).mockResolvedValue({ err: new Response("no", { status: 401 }) });
    expect((await post({ prompt: "prisma 손보자 지금" })).status).toBe(401);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

/* 레슨 범위·주입 방식 — 라우트 수준: 요청의 '사람'(사람 세션 = 본인, 에이전트 토큰 = 발급자)으로
   개인 레슨을 고르고, ondemand 는 compact·brief 어디에도 넣지 않는다. */

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({
  loadAccess: vi.fn(async () => ({})),
  pageAccess: () => "view",
  projectAccess: vi.fn(() => "view"),
  visibleOnly: (_i: unknown, r: unknown[]) => r,
}));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn(async () => ({ nodes: [], edges: [] })) }));
vi.mock("@/lib/prisma", () => {
  const fm = () => ({ findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) });
  return {
    prisma: {
      workspaceRouteRule: fm(), project: fm(), workspace: fm(), page: fm(), dbProperty: fm(), dbRow: fm(),
      decision: fm(), risk: fm(), glossaryTerm: fm(), lesson: fm(), envTarget: fm(),
    },
  };
});

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const P = "proj1";
const CWD = "/Users/me/dev/app";
const lessons = [
  { id: "glob1", title: "전역 규칙", body: "처방: 전역", projectId: null, stack: null, userId: null, mode: "default" },
  { id: "req1", title: "필수 규칙", body: "처방: 꼭", projectId: null, stack: null, userId: null, mode: "required" },
  { id: "od1", title: "가끔 규칙", body: "처방: 가끔", projectId: P, stack: null, userId: null, mode: "ondemand" },
  { id: "mine1", title: "내 습관", body: "처방: 나", projectId: null, stack: null, userId: "human1", mode: "default" },
  { id: "yours1", title: "남의 습관", body: "처방: 남", projectId: null, stack: null, userId: "human2", mode: "required" },
];
const db = () => prisma as unknown as Record<string, { findMany: Mock; findUnique: Mock; count: Mock }>;

function seed(ctx: Record<string, unknown>) {
  m(requireCtx).mockResolvedValue(ctx);
  const p = db();
  p.workspaceRouteRule.findMany.mockResolvedValue([{ cwdPrefix: CWD, workspaceId: "w1", projectId: P, priority: 0 }]);
  p.project.findUnique.mockResolvedValue({ name: "앱", stack: [] });
  p.workspace.findUnique.mockResolvedValue({ name: "팀" });
  // DB 가 where 를 무시하고 전부 돌려줘도(방어) 렌더 단계가 다시 거른다
  p.lesson.findMany.mockResolvedValue(lessons);
  p.lesson.count.mockResolvedValue(lessons.length);
}
const get = async (q: string) => (await GET(new Request(`http://t/api/context?cwd=${encodeURIComponent(CWD)}&${q}`))).text();
const lessonWhere = () => db().lesson.findMany.mock.calls[0][0].where as { AND: unknown };

describe("GET /api/context — 레슨 범위·주입 방식", () => {
  beforeEach(() => vi.resetAllMocks());

  it("사람 세션: 내 개인 레슨만 읽고 넣는다, 필수는 맨 앞, ondemand 는 빠진다", async () => {
    seed({ workspaceId: "w1", userId: "human1", role: "admin", actor: { type: "user", id: "human1", name: "이준" }, personId: "human1" });
    const md = await get("compact=1");
    expect(lessonWhere().AND).toEqual([{ OR: [{ userId: null }, { userId: "human1" }] }]);
    expect(md).toContain("`mine1`");
    expect(md).not.toContain("yours1");
    expect(md).not.toContain("`od1`");
    expect(md).toContain("'필요할 때만' 레슨 1개");
    expect(md.indexOf("### 필수 (1)")).toBeLessThan(md.indexOf("### 개인 (1)"));
  });

  it("에이전트 토큰: 발급자의 개인 레슨 — admin 토큰이어도 남의 것은 안 들어간다", async () => {
    seed({ workspaceId: "w1", userId: "agentU", role: "admin", actor: { type: "agent", id: "agentU", name: "mac" }, personId: "human2" });
    const md = await get("compact=1");
    expect(lessonWhere().AND).toEqual([{ OR: [{ userId: null }, { userId: "human2" }] }]);
    expect(md).toContain("`yours1`");
    expect(md).not.toContain("mine1");
  });

  it("발급자 미상 토큰: 개인 레슨은 하나도 읽지 않는다", async () => {
    seed({ workspaceId: "w1", userId: "agentU", role: "editor", actor: { type: "agent", id: "agentU", name: "old" }, personId: null });
    const md = await get("compact=1");
    expect(lessonWhere().AND).toEqual([{ OR: [{ userId: null }] }]);
    expect(md).not.toContain("mine1");
    expect(md).not.toContain("yours1");
    expect(md).not.toContain("### 개인");
  });

  it("brief 도 같은 판정: 필수·내 개인은 제목·id, 남의 개인·ondemand 는 없다", async () => {
    seed({ workspaceId: "w1", userId: "human1", role: "editor", actor: { type: "user", id: "human1", name: "이준" }, personId: "human1" });
    const md = await get("brief=1");
    expect(md).toContain("`req1`");
    expect(md).toContain("`mine1`");
    expect(md).not.toContain("yours1");
    expect(md).not.toContain("od1");
  });
});

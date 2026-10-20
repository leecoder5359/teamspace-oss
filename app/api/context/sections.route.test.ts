import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

/* sections=lessons — SubagentStart 훅(scripts/hooks/teamspace-subagent-start.mjs)용: 세션 레포의 레슨 섹션만.
   필수 + 프로젝트 범위만 싣고(개인·스택·전역 기본은 빠짐), 보드·문서·결정·지식 지도는 읽지도 않는다. 예산 LESSON_BUDGET. */

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({
  loadAccess: vi.fn(async () => ({})),
  pageAccess: () => "view",
  projectAccess: vi.fn(() => "view"),
  visibleOnly: (_i: unknown, r: unknown[]) => r,
}));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn(async () => ({ nodes: [], edges: [] })) }));
vi.mock("@/lib/lessonInspect/log", async (orig) => ({ ...(await orig<object>()), recordLessonInjection: vi.fn(async () => {}) }));
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
import { loadGraph } from "@/lib/graphLoad";
import { recordLessonInjection } from "@/lib/lessonInspect/log";
import { LESSON_BUDGET } from "@/lib/lessonInject";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const P = "proj1";
const CWD = "/Users/me/dev/app";
const lessons = [
  { id: "req1", title: "필수 규칙", body: "처방: 꼭", projectId: null, stack: null, userId: null, mode: "required" },
  { id: "proj1a", title: "프로젝트 규칙", body: "처방: 이 레포", projectId: P, stack: null, userId: null, mode: "default" },
  { id: "glob1", title: "전역 기본", body: "처방: 전역", projectId: null, stack: null, userId: null, mode: "default" },
  { id: "mine1", title: "내 습관", body: "처방: 나", projectId: null, stack: null, userId: "human1", mode: "default" },
  { id: "stk1", title: "스택 규칙", body: "처방: next", projectId: null, stack: "next", userId: null, mode: "default" },
  { id: "od1", title: "가끔 규칙", body: "처방: 가끔", projectId: P, stack: null, userId: null, mode: "ondemand" },
];
const db = () => prisma as unknown as Record<string, { findMany: Mock; findUnique: Mock; count: Mock }>;

function seed(list = lessons) {
  m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "human1", role: "admin", actor: { type: "user", id: "human1", name: "이준" }, personId: "human1" });
  const p = db();
  p.workspaceRouteRule.findMany.mockResolvedValue([{ cwdPrefix: CWD, workspaceId: "w1", projectId: P, priority: 0 }]);
  p.project.findMany.mockResolvedValue([]);
  p.project.findUnique.mockResolvedValue({ name: "앱", stack: ["next"] });
  p.workspace.findUnique.mockResolvedValue({ name: "팀" });
  p.lesson.findMany.mockResolvedValue(list);
  p.lesson.count.mockResolvedValue(list.length);
}
const call = (q: string) => GET(new Request(`http://t/api/context?cwd=${encodeURIComponent(CWD)}&${q}`));

describe("GET /api/context?sections=lessons", () => {
  beforeEach(() => vi.resetAllMocks());

  it("레슨 섹션만 — 필수 + 프로젝트 범위 + 내 개인(제목+id), 스택·전역 기본·ondemand 는 빠진다", async () => {
    seed();
    const res = await call("compact=1&sections=lessons&via=SubagentStart");
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md.startsWith("## 팀 작업규칙·레슨")).toBe(true);
    expect(md).toContain("`req1`");
    expect(md).toContain("`proj1a`");
    expect(md).toContain("- **내 습관** `mine1`");
    for (const id of ["glob1", "stk1", "od1"]) expect(md).not.toContain(`\`${id}\``);
    expect(md).not.toContain("## 태스크 보드");
    expect(md).not.toContain("## 문서");
    expect(md).not.toContain("## 워크스페이스");
  });

  it("보드·문서·결정·리스크·용어집·지식 지도는 읽지 않는다", async () => {
    seed();
    await call("compact=1&sections=lessons");
    const p = db();
    for (const k of ["dbProperty", "dbRow", "decision", "risk", "glossaryTerm"]) expect(p[k].findMany).not.toHaveBeenCalled();
    expect(p.page.findMany).not.toHaveBeenCalled();
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("예산 LESSON_BUDGET 안 — 레슨이 많아도 넘치지 않고 '외 N개' 를 적는다", async () => {
    const many = Array.from({ length: 80 }, (_, k) => ({
      id: `p${k}`, title: `${"아주 긴 프로젝트 규칙 제목 ".repeat(5)}${k}`, body: `처방: ${"길게 ".repeat(60)}`, projectId: P, stack: null, userId: null, mode: "default",
    }));
    seed(many);
    const md = await (await call("compact=1&sections=lessons")).text();
    expect(md.length).toBeLessThanOrEqual(LESSON_BUDGET);
    expect(md).toMatch(/외 \d+개/);
  });

  it("주입 기록은 via 그대로 compact 1행", async () => {
    seed();
    await call("compact=1&sections=lessons&via=SubagentStart");
    expect(recordLessonInjection).toHaveBeenCalledTimes(1);
    expect(m(recordLessonInjection).mock.calls[0][0]).toMatchObject({ via: "SubagentStart", mode: "compact", projectId: P });
  });

  it("format=json 은 { markdown, counts.lessons }", async () => {
    seed();
    const j = await (await call("compact=1&sections=lessons&format=json")).json();
    expect(j.markdown).toContain("`req1`");
    expect(j.counts).toEqual({ lessons: 4 }); // 범위 안 레슨(필수·프로젝트·내 개인, ondemand 포함 — 렌더에선 '필요할 때만' 안내로)
  });

  it("keyword audience:main 레슨은 빠지고 '메인 전용 N건 제외' 한 줄 — select 에 keywords 를 싣는다", async () => {
    seed([...lessons, { id: "mainonly", title: "메인 전용", body: "처방: 메인만", projectId: null, stack: null, userId: null, mode: "required", keywords: ["audience:main"] } as (typeof lessons)[number]]);
    const md = await (await call("compact=1&sections=lessons")).text();
    expect(md).not.toContain("`mainonly`");
    expect(md).toContain("메인 전용 1건 제외");
    expect(db().lesson.findMany.mock.calls[0][0].select.keywords).toBe(true);
  });

  it("모르는 sections 값은 400", async () => {
    seed();
    expect((await call("sections=tasks")).status).toBe(400);
  });
});

/* sections=project — PostToolUse 훅(scripts/hooks/teamspace-project-context.mjs)용 델타: 그 프로젝트 범위 레슨 + 계정·태스크·개수 한 줄.
   세션 시작에 이미 들어간 전역·개인·필수(전역) 레슨, 지식 지도·용어집·문서 목록·결정은 싣지 않는다. */
describe("GET /api/context?sections=project", () => {
  beforeEach(() => vi.resetAllMocks());
  const seedBoard = () => {
    const p = db();
    p.page.findMany.mockImplementation(async (a: { where: { kind: string } }) => (a.where.kind === "database" ? [{ id: "db1" }] : []));
    p.dbProperty.findMany.mockResolvedValue([
      { id: "t", name: "이름", type: "text", config: {}, position: 0 },
      { id: "s", name: "상태", type: "select", config: { options: [{ id: "o1", name: "진행 중" }, { id: "o2", name: "완료" }] }, position: 1 },
      { id: "a", name: "담당", type: "text", config: {}, position: 2 },
    ]);
    p.dbRow.findMany.mockResolvedValue([
      { props: { t: "내 일", s: "o1", a: "이준" } },
      { props: { t: "끝난 일", s: "o2", a: "이준" } },
    ]);
    p.page.count.mockResolvedValue(12);
    p.decision.count.mockResolvedValue(3);
  };

  it("프로젝트·스택 범위 레슨 + 태스크 + 개수 줄 — 전역·개인·지식 지도·용어집·문서 목록·결정은 없다", async () => {
    seed();
    seedBoard();
    const res = await call("compact=1&sections=project&via=PostToolUse");
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md.split("\n")[0]).toBe("# 워크스페이스: 팀 · 프로젝트: 앱 (프로젝트 델타)");
    expect(md).toContain("`proj1a`");
    expect(md).toContain("`stk1`");
    for (const id of ["req1", "glob1", "mine1", "od1"]) expect(md).not.toContain(`\`${id}\``);
    expect(md).toContain("- 내 일 — 진행 중 · 나");
    expect(md).not.toContain("끝난 일");
    expect(md).toContain("태스크 1 · 문서 12 · 결정 3");
    for (const h of ["## 지식 지도", "## 용어집", "## 문서", "## 결정"]) expect(md).not.toContain(h);
    expect(loadGraph).not.toHaveBeenCalled();
    const p = db();
    for (const k of ["decision", "risk", "glossaryTerm"]) expect(p[k].findMany).not.toHaveBeenCalled();
  });

  it("주입 기록은 mode=project, via 그대로, 보인 레슨 id 만", async () => {
    seed();
    seedBoard();
    await call("compact=1&sections=project&via=PostToolUse");
    expect(recordLessonInjection).toHaveBeenCalledTimes(1);
    const rec = m(recordLessonInjection).mock.calls[0][0];
    expect(rec).toMatchObject({ via: "PostToolUse", mode: "project", projectId: P });
    expect([...rec.ids.gistIds, ...rec.ids.titleIds].sort()).toEqual(["proj1a", "stk1"]);
  });

  it("inspect=1 이면 기록하지 않는다", async () => {
    seed();
    seedBoard();
    await call("sections=project&inspect=1");
    expect(recordLessonInjection).not.toHaveBeenCalled();
  });
});

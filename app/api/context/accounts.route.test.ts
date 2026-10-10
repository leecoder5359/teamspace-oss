import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* P3c 세션 계정 주입 — 라우트 수준.
   골든 파일(__fixtures__/compact-no-targets.golden.txt)은 P3c 이전 라우트(a3e1fc8)로 만든 출력이다.
   반영 대상이 없는 프로젝트의 compact·brief 출력이 그것과 바이트 단위로 같아야 한다.
   (다시 만들 일은 없어야 한다 — 만들 땐 이전 라우트로 CONTEXT_GOLDEN_WRITE=1)
   2026-10-10 레슨 예산 개편(필수 먼저·좁은 범위 먼저)으로 레슨 요약 줄 배분만 바뀌어 다시 만들었다 — 계정 줄과 무관. */

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({
  loadAccess: vi.fn(async () => ({})),
  pageAccess: () => "view",
  projectAccess: vi.fn(() => "view"),
  visibleOnly: (_i: unknown, r: unknown[]) => r,
}));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));
vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, default: { ...real, homedir: () => "/Users/me" }, homedir: () => "/Users/me" };
});
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
import { loadGraph } from "@/lib/graphLoad";
import { projectAccess } from "@/lib/pageGuard";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";
import { CONTEXT_BUDGET } from "@/lib/lessonInject";

const m = (f: unknown) => f as Mock;
const P = "proj1";
const CWD = "/Users/me/dev/app";
const lessons = [
  ...Array.from({ length: 120 }, (_, i) => ({ id: `gl${i}`, title: `전역 레슨 ${i}`, body: `처방: 전역 규칙 ${i} 은 이렇게 한다 `.repeat(4), projectId: null, stack: null })),
  ...Array.from({ length: 90 }, (_, i) => ({ id: `pl${i}`, title: `프로젝트 레슨 ${i}`, body: `처방: 프로젝트 규칙 ${i} `.repeat(5), projectId: P, stack: null })),
];
const db = () => prisma as unknown as Record<string, { findMany: Mock; findUnique: Mock; count: Mock }>;

function seed() {
  m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member", actor: { type: "agent", id: "a1", name: "에이전트" } });
  m(loadGraph).mockResolvedValue({ nodes: [], edges: [] });
  m(projectAccess).mockReturnValue("view");
  const p = db();
  p.workspaceRouteRule.findMany.mockResolvedValue([{ cwdPrefix: "/Users/me/dev/app", workspaceId: "w1", projectId: P, priority: 0 }]);
  p.project.findUnique.mockResolvedValue({ name: "앱", stack: [] });
  p.workspace.findUnique.mockResolvedValue({ name: "팀" });
  p.page.findMany.mockImplementation(async (a: { where: { kind: string } }) =>
    a.where.kind === "doc" ? Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, title: `문서 ${i}`, updatedAt: new Date(0) })) : [],
  );
  p.dbProperty.findMany.mockResolvedValue([]);
  p.dbRow.findMany.mockResolvedValue([]);
  p.decision.findMany.mockResolvedValue([{ title: "결정 A", decision: "이렇게 간다" }]);
  p.risk.findMany.mockResolvedValue([{ title: "리스크 A", severity: "high" }]);
  p.glossaryTerm.findMany.mockResolvedValue([{ term: "용어", definition: "뜻" }]);
  p.lesson.findMany.mockResolvedValue(lessons);
  p.envTarget.findMany.mockResolvedValue([]);
  // 개수는 count 로 센다 — 목록 모의와 같은 값을 줘야 골든(헤더·brief 개수 줄)이 그대로다.
  p.page.count.mockImplementation(async (a: { where: { kind?: string } }) => (a.where.kind === "doc" ? 12 : 0));
  p.decision.count.mockResolvedValue(1);
  p.risk.count.mockResolvedValue(1);
  p.glossaryTerm.count.mockResolvedValue(1);
  p.lesson.count.mockResolvedValue(lessons.length);
}

const get = async (q: string) => (await GET(new Request(`http://t/api/context?cwd=${encodeURIComponent(CWD)}&${q}`))).text();
const GOLDEN = join(__dirname, "__fixtures__", "compact-no-targets.golden.txt");

describe("GET /api/context — 계정 줄(P3c)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    seed();
  });

  it("반영 대상이 없으면 compact·brief 출력이 P3c 이전과 바이트 단위로 같다", async () => {
    const compact = await get("compact=1");
    const brief = await get("brief=1");
    const golden = `${compact}\n=====BRIEF=====\n${brief}`;
    if (process.env.CONTEXT_GOLDEN_WRITE === "1") writeFileSync(GOLDEN, golden);
    expect(golden).toBe(readFileSync(GOLDEN, "utf8"));
    expect(compact).not.toContain("## 계정");
  });

  it("대상이 있으면 머리말 바로 뒤(레슨 앞)에 계정 섹션, 전체 길이는 레슨이 양보해 늘지 않는다", async () => {
    const base = await get("compact=1");
    db().envTarget.findMany.mockResolvedValue([
      { kind: "ssm", config: { prefix: "/acme/dev", profile: "acme" }, account: { accountId: "123456789012" } },
      { kind: "ssm", config: { prefix: "/acme/prod", profile: "acme" }, account: { accountId: "123456789012" } },
      { kind: "vercel", config: { project: "teamspace", target: "production", globalDir: "/Users/me/.vercel-alt" }, account: { user: "leecoder5359" } },
    ]);
    const md = await get("compact=1");
    const lines = md.split("\n");
    expect(lines.indexOf("## 계정 (env 금고 반영 대상)")).toBe(3);
    expect(lines[4]).toBe("- AWS: 계정 123456789012 · 프로필 acme (SSM /acme/dev·/acme/prod)");
    expect(lines[5]).toBe("- Vercel: leecoder5359 · -Q ~/.vercel-alt (프로젝트 teamspace)");
    expect(lines[6]).toBe("");
    expect(lines[7]).toMatch(/^## .*레슨/);
    // 계정 줄은 레슨 예산(restChars)에서 빠진다 — 레슨 섹션이 줄고 전체는 CONTEXT_BUDGET 안(줄 단위라 몇십 자 오차)
    const lessonPart = (s: string) => s.slice(s.indexOf("## 팀 작업규칙"), s.indexOf("## 태스크 보드"));
    expect(lessonPart(md).length).toBeLessThan(lessonPart(base).length);
    expect(base.length).toBeGreaterThan(CONTEXT_BUDGET - 600); // 레슨이 예산을 채우는 상황인지(전제)
    expect(md.length).toBeLessThanOrEqual(CONTEXT_BUDGET);
    expect(db().envTarget.findMany.mock.calls.at(-1)?.[0].where).toEqual({ workspaceId: "w1", projectId: P });
  });

  it("brief 는 가장 중요한 1줄만", async () => {
    db().envTarget.findMany.mockResolvedValue([
      { kind: "gha", config: { repo: "o/r" }, account: { login: "me" } },
      { kind: "ssm", config: { prefix: "/a" }, account: { accountId: "111111111111" } },
    ]);
    const lines = (await get("brief=1")).split("\n");
    expect(lines[3]).toBe("## 계정 (env 금고 반영 대상)");
    expect(lines[4]).toBe("- AWS: 계정 111111111111 (SSM /a)");
    expect(lines[5]).toBe("");
    expect(lines.join("\n")).not.toContain("GitHub");
  });

  it("볼 수 없는 프로젝트·전체 모드(compact 아님)·cwd 미매핑이면 조회하지 않는다", async () => {
    db().envTarget.findMany.mockResolvedValue([{ kind: "ssm", config: { prefix: "/a" }, account: { accountId: "111111111111" } }]);
    m(projectAccess).mockReturnValue("none");
    expect(await get("compact=1")).not.toContain("## 계정");
    m(projectAccess).mockReturnValue("view");
    expect(await get("")).not.toContain("## 계정");
    expect(await (await GET(new Request("http://t/api/context?cwd=/elsewhere&compact=1"))).text()).not.toContain("## 계정");
    expect(db().envTarget.findMany).not.toHaveBeenCalled();
  });

  it("대상 조회가 실패해도 컨텍스트는 나간다(섹션만 생략)", async () => {
    db().envTarget.findMany.mockRejectedValue(new Error("db"));
    const res = await GET(new Request(`http://t/api/context?cwd=${encodeURIComponent(CWD)}&compact=1`));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("## 계정");
  });
});

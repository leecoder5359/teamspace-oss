import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findMany: vi.fn(async () => []) },
    page: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: vi.fn(async () => ({ id: "board1" })), update: vi.fn(async () => ({})) },
    dbProperty: { create: vi.fn() },
    dbView: { create: vi.fn(async () => ({})) },
    dbRow: { createMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn(async () => ({ ok: true, projectId: "p1" })) }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), projectAccess: vi.fn(() => "view") }));
vi.mock("@/lib/unzip", () => ({ readZip: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

import { importZip } from "./importService";
import { readZip } from "@/lib/unzip";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";

const guard = { workspaceId: "w1", userId: "u1", role: "editor" as const, actor: { type: "user" as const, id: "u1", name: "U" } };

describe("importService.importZip", () => {
  it("강제 프로젝트에 편집 권한이 없으면 ok:false 403 — zip 을 풀지 않는다", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "a.zip");
    const r = await importZip(guard, { file, dryRun: true, createProjects: false, skipExisting: false, projectRef: "p1" });
    expect(r).toEqual({ ok: false, status: 403, error: "이 프로젝트에 문서를 만들 권한이 없습니다." });
    expect(readZip).not.toHaveBeenCalled();
  });

  it("이름 매칭용 프로젝트 조회는 보관 프로젝트를 제외한다", async () => {
    vi.mocked(resolveProjectRef).mockResolvedValueOnce({ ok: true, projectId: null } as never);
    vi.mocked(readZip).mockReturnValue([{ path: "a.md", data: Buffer.from("# 문서\n본문") }] as never);
    const file = new File([new Uint8Array([1])], "a.zip");
    await importZip(guard, { file, dryRun: true, createProjects: false, skipExisting: false, projectRef: "" });
    const call = vi.mocked(prisma.project.findMany).mock.calls[0]?.[0] as { where: unknown } | undefined;
    expect(call?.where).toEqual({ workspaceId: "w1", archivedAt: null });
  });
});

describe("importService.importZip 보드 행 비정규화 칸(감사 P-14)", () => {
  it("CSV 보드 행을 만들 때 상태 옵션 id·담당자·키를 함께 쓴다", async () => {
    let n = 0;
    vi.mocked(prisma.dbProperty.create).mockImplementation((async () => ({ id: `prop${n++}` })) as never);
    vi.mocked(resolveProjectRef).mockResolvedValueOnce({ ok: true, projectId: null } as never);
    vi.mocked(readZip).mockReturnValue([{ path: "보드.csv", data: Buffer.from("이름,상태,담당자\na,할 일,이준\nb,할 일,남\nc,완료,김\n") }] as never);
    const file = new File([new Uint8Array([1])], "a.zip");
    const r = await importZip(guard, { file, dryRun: false, createProjects: false, skipExisting: false, projectRef: "" });
    expect(r.ok).toBe(true);
    const data = (vi.mocked(prisma.dbRow.createMany).mock.calls[0][0] as { data: Record<string, unknown>[] }).data;
    expect(data.map((d) => [d.assigneeText, d.taskColsKey])).toEqual([["이준", "prop1|prop2"], ["남", "prop1|prop2"], ["김", "prop1|prop2"]]);
    expect(data[0].statusOptionId).toBe((data[0].props as Record<string, unknown>).prop1);
    expect(data[2].statusOptionId).not.toBe(data[0].statusOptionId);
  });
});

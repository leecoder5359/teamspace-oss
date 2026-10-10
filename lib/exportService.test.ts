import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => {
  const many = () => ({ findMany: vi.fn(async () => []) });
  return {
    prisma: {
      workspace: { findUnique: vi.fn(async () => null) },
      project: many(), page: many(), decision: many(), lesson: many(), glossaryTerm: many(), risk: many(),
      qaScenario: many(), entity: many(), dodItem: many(), onboardingStep: many(), changelogEntry: many(),
    },
  };
});
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), visibleOnly: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

import { buildWorkspaceExport } from "./exportService";
import { loadAccess } from "@/lib/pageGuard";
import { recordActivity } from "@/lib/activity";

const guard = { workspaceId: "w1", userId: "u1", role: "editor" as const, actor: { type: "user" as const, id: "u1", name: "U" } };

describe("exportService.buildWorkspaceExport", () => {
  it("워크스페이스가 없으면 ok:false 404 — 접근 색인·활동 기록 없음", async () => {
    const r = await buildWorkspaceExport(guard, { withAttachments: true });
    expect(r).toEqual({ ok: false, status: 404, error: "워크스페이스를 찾을 수 없습니다." });
    expect(loadAccess).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

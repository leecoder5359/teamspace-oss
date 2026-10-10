import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { dbRow: { findUnique: vi.fn(async () => null) } } }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn(), gatePage: vi.fn(), notFound: vi.fn() }));
vi.mock("@/lib/relationServer", () => ({ validateRelationProps: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

import { moveRow } from "./rowMoveService";
import { requirePage } from "@/lib/pageGuard";

const guard = { workspaceId: "w1", userId: "u1", role: "editor" as const, actor: { type: "user" as const, id: "u1", name: "U" } };

describe("rowMoveService.moveRow", () => {
  it("행이 없으면 ok:false 404 — 게이트까지 가지 않는다", async () => {
    const r = await moveRow(guard, "nope", { targetId: "b2", dryRun: true, createMissingOptions: false });
    expect(r).toEqual({ ok: false, status: 404, error: "Not found" });
    expect(requirePage).not.toHaveBeenCalled();
  });
});

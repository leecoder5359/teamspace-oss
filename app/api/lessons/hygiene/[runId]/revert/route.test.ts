import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/lessonHygiene/service", async () => {
  class HygieneError extends Error {
    constructor(public status: number, message: string) { super(message); }
  }
  return { HygieneError, revertHygieneRun: vi.fn() };
});

import { requireCtx } from "@/lib/workspace";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { HygieneError, revertHygieneRun } from "@/lib/lessonHygiene/service";
import { POST } from "./route";

/* 되돌리기는 지운 레슨을 원래 id 로 다시 만들고 범위(projectId·userId)도 되돌린다 — 그래프 캐시를 즉시 비운다. */
const m = (f: unknown) => f as Mock;
const call = () => POST(new Request("http://t/api/lessons/hygiene/run1/revert", { method: "POST" }), { params: Promise.resolve({ runId: "run1" }) });

describe("POST /api/lessons/hygiene/[runId]/revert 그래프 캐시", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "admin" });
  });

  it("되돌리면 비운다", async () => {
    m(revertHygieneRun).mockResolvedValue({ restored: 1, recreated: 2 });
    expect((await call()).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("되돌릴 수 없으면(409) 비우지 않는다", async () => {
    m(revertHygieneRun).mockRejectedValue(new (HygieneError as unknown as new (s: number, m: string) => Error)(409, "이미 되돌림"));
    expect((await call()).status).toBe(409);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});

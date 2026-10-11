import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requireProject: vi.fn() }));
vi.mock("@/lib/projectRef", () => ({ resolveMemberRef: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { requireProject } from "@/lib/pageGuard";
import { prisma } from "@/lib/prisma";
import { PATCH } from "./route";

const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "p1" }) };
const patch = (body: unknown) => PATCH(new Request("http://t/api/projects/p1", { method: "PATCH", body: JSON.stringify(body) }), params);

describe("PATCH /api/projects/[id] — aliases(프롬프트 매칭 별칭)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(requireProject).mockResolvedValue({ level: "edit" });
    m(prisma.project.findUnique).mockResolvedValue({ id: "p1", workspaceId: "w1", archivedAt: null });
    m(prisma.project.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "p1", ...data }));
  });

  it("쉼표 문자열·배열 → 소문자·중복 제거, null 은 비움", async () => {
    await patch({ aliases: "반장, Banjang ,banjang" });
    expect(m(prisma.project.update).mock.calls[0][0].data).toEqual({ aliases: ["반장", "banjang"] });
    await patch({ aliases: ["로요", "LOYO"] });
    expect(m(prisma.project.update).mock.calls[1][0].data).toEqual({ aliases: ["로요", "loyo"] });
    await patch({ aliases: null });
    expect(m(prisma.project.update).mock.calls[2][0].data).toEqual({ aliases: [] });
  });

  it("1자 별칭은 400(아무 데나 맞는다)", async () => {
    const res = await patch({ aliases: "반" });
    expect(res.status).toBe(400);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it("aliases 를 안 주면 건드리지 않는다", async () => {
    await patch({ name: "새 이름" });
    expect(m(prisma.project.update).mock.calls[0][0].data).toEqual({ name: "새 이름" });
  });
});

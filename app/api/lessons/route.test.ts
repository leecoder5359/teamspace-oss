import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { lesson: { findMany: vi.fn(), count: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const get = (qs = "") => GET(new Request(`http://t/api/lessons${qs}`));

describe("GET /api/lessons", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer" });
    m(prisma.lesson.findMany).mockResolvedValue([{ id: "l1", title: "배포 규칙" }]);
    m(prisma.lesson.count).mockResolvedValue(7);
  });

  it("q 는 제목 부분일치(대소문자 무시)로 where 에 실린다", async () => {
    await get("?q=%20%EB%B0%B0%ED%8F%AC%20");
    const { where } = m(prisma.lesson.findMany).mock.calls[0][0];
    expect(where).toEqual({ workspaceId: "w1", title: { contains: "배포", mode: "insensitive" } });
  });

  it("limit 은 1..300 으로 맞춰 take 에 실리고, 생략하면 take 가 없다", async () => {
    await get("?limit=9999");
    expect(m(prisma.lesson.findMany).mock.calls[0][0].take).toBe(300);
    await get("?limit=0");
    expect(m(prisma.lesson.findMany).mock.calls[1][0].take).toBe(1);
    await get();
    expect(m(prisma.lesson.findMany).mock.calls[2][0]).not.toHaveProperty("take");
  });

  it("total 은 limit 앞의 건수(count)이고 같은 where 를 쓴다", async () => {
    const j = await (await get("?q=a&limit=1")).json();
    expect(j).toEqual({ lessons: [{ id: "l1", title: "배포 규칙" }], total: 7 });
    expect(m(prisma.lesson.count).mock.calls[0][0].where).toEqual(m(prisma.lesson.findMany).mock.calls[0][0].where);
  });

  it("projectId 는 전역(null)과 해당 프로젝트를 함께 낸다", async () => {
    await get("?projectId=p1");
    expect(m(prisma.lesson.findMany).mock.calls[0][0].where.OR).toEqual([{ projectId: "p1" }, { projectId: null }]);
  });
});

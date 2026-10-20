import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { dbRow: { findMany: vi.fn() }, dbProperty: { findMany: vi.fn() } } }));

import { prisma } from "@/lib/prisma";
import { findTaskRows, taskColumnsForBoard, taskRowQueries } from "./taskRows";

const m = (f: unknown) => f as Mock;
const status = { id: "pS", name: "상태", type: "select", config: { options: [{ id: "o1", name: "할 일" }, { id: "o3", name: "완료" }] } };
const assignee = { id: "pA", name: "담당자", type: "text" };
const props = [{ id: "pT", name: "제목", type: "text" }, status, assignee];

describe("taskRowQueries", () => {
  it("빠른 쿼리는 지금 키와 같은 행만 칸으로 거르고, 낡은 쿼리는 키가 없거나 다른 행 전부", () => {
    const q = taskRowQueries("db1", "pS|pA", { closedOptionIds: ["o3"], assignee: "Claude" });
    expect(q).toEqual({
      fast: { databasePageId: "db1", taskColsKey: "pS|pA", OR: [{ statusOptionId: null }, { statusOptionId: { notIn: ["o3"] } }], assigneeText: "Claude" },
      stale: { databasePageId: "db1", OR: [{ taskColsKey: null }, { taskColsKey: { not: "pS|pA" } }] },
    });
  });

  it("거를 것이 없으면 null — 호출자는 보드 전체를 한 번에 읽는다", () => {
    expect(taskRowQueries("db1", "pS|pA", {})).toBeNull();
    expect(taskRowQueries("db1", "pS|pA", { closedOptionIds: [], assignee: "" })).toBeNull();
  });

  it("상태만·담당자만도 각각 그 조건만 싣는다", () => {
    expect(taskRowQueries("db1", "k", { closedOptionIds: ["o3"] })!.fast).toEqual({ databasePageId: "db1", taskColsKey: "k", OR: [{ statusOptionId: null }, { statusOptionId: { notIn: ["o3"] } }] });
    expect(taskRowQueries("db1", "k", { assignee: "A" })!.fast).toEqual({ databasePageId: "db1", taskColsKey: "k", assigneeText: "A" });
  });
});

describe("findTaskRows", () => {
  beforeEach(() => vi.resetAllMocks());
  const row = (id: string, position: number) => ({ id, position, props: {} });

  it("빠른 행과 낡은 행을 position 순으로 합친다", async () => {
    m(prisma.dbRow.findMany).mockResolvedValueOnce([row("a", 0), row("c", 5)]).mockResolvedValueOnce([row("b", 2), row("d", 9)]);
    const out = await findTaskRows("db1", props, { closedOptionIds: ["o3"] });
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    const [fast, stale] = m(prisma.dbRow.findMany).mock.calls.map((c) => c[0]);
    expect(fast).toEqual({ where: taskRowQueries("db1", "pS|pA", { closedOptionIds: ["o3"] })!.fast, orderBy: { position: "asc" } });
    expect(stale.where.OR).toEqual([{ taskColsKey: null }, { taskColsKey: { not: "pS|pA" } }]);
  });

  it("거를 것이 없으면 보드 전체를 한 번 읽는다(예전과 같은 쿼리)", async () => {
    m(prisma.dbRow.findMany).mockResolvedValueOnce([row("a", 0)]);
    await findTaskRows("db1", props, {});
    expect(m(prisma.dbRow.findMany).mock.calls).toEqual([[{ where: { databasePageId: "db1" }, orderBy: { position: "asc" } }]]);
  });
});

describe("taskColumnsForBoard", () => {
  beforeEach(() => vi.resetAllMocks());

  it("보드 속성을 position 순으로 읽어 칸을 만든다", async () => {
    m(prisma.dbProperty.findMany).mockResolvedValue(props);
    const out = await taskColumnsForBoard("db1", { pS: "o1", pA: " B " });
    expect(out).toEqual({ statusOptionId: "o1", assigneeText: "B", taskColsKey: "pS|pA" });
    expect(m(prisma.dbProperty.findMany).mock.calls[0][0]).toEqual({
      where: { databasePageId: "db1" },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true, name: true, type: true, config: true },
    });
  });

  it("트랜잭션 클라이언트를 받으면 그걸로 읽는다", async () => {
    const tx = { dbProperty: { findMany: vi.fn().mockResolvedValue([status]) } };
    await taskColumnsForBoard("db1", {}, tx as never);
    expect(tx.dbProperty.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.dbProperty.findMany).not.toHaveBeenCalled();
  });
});

import { REDERIVE_TASK_COLUMNS_SQL } from "./taskColumnsSql";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * 감사 P-14 비정규화 칸 — 실제 Postgres 통합 테스트. 전용 테스트 DB(teamspace_test 등, 마이그레이션 적용됨)가 주어질 때만 돈다:
 *   TASK_COLS_TEST_DATABASE_URL=postgresql://…/teamspace_test pnpm vitest run lib/taskRows.db.test.ts
 * (운영/개발 DB 를 가리키지 말 것 — 보드를 만들고 지운다.)
 * 확인하는 것: ① 마이그레이션 백필 SQL 이 lib/taskColumns.deriveTaskColumns 와 같은 값을 낸다(이 테스트가 만든 보드에만 돌린다)
 *             ② findTaskRows 가 칸 있는 행은 DB 에서, 키가 다른 행은 통째로 가져온다.
 */
const DB = process.env.TASK_COLS_TEST_DATABASE_URL;

describe.skipIf(!DB)("DbRow 비정규화 칸(실DB)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let rows: typeof import("./taskRows");
  let cols: typeof import("./taskColumns");
  let wsId: string;
  let boardId: string;
  const stamp = Date.now();

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    ({ prisma } = await import("@/lib/prisma"));
    rows = await import("./taskRows");
    cols = await import("./taskColumns");
    const ws = await prisma.workspace.create({ data: { name: `taskcols-test-${stamp}` } });
    wsId = ws.id;
    const user = await prisma.user.create({ data: { email: `taskcols-${stamp}@taskcols.test`, name: "P-14" } });
    const board = await prisma.page.create({ data: { workspaceId: wsId, kind: "database", title: "P-14 보드", createdById: user.id } });
    boardId = board.id;
    await prisma.dbProperty.createMany({
      data: [
        { id: `t-${stamp}`, databasePageId: boardId, name: "이름", type: "text", position: 0 },
        { id: `pri-${stamp}`, databasePageId: boardId, name: "우선순위", type: "select", position: 1, config: { options: [{ id: "hi", name: "높음" }] } },
        { id: `s-${stamp}`, databasePageId: boardId, name: "상태", type: "select", position: 2, config: { options: [{ id: "o1", name: "할 일" }, { id: "o3", name: "완료" }] } },
        { id: `a-${stamp}`, databasePageId: boardId, name: "담당자", type: "text", position: 3 },
      ],
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workspace.deleteMany({ where: { name: { startsWith: "taskcols-test-" } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@taskcols.test" } } });
    await prisma.$disconnect();
  });

  it("백필 SQL 결과가 deriveTaskColumns 와 같다", async () => {
    const S = `s-${stamp}`, A = `a-${stamp}`, T = `t-${stamp}`;
    const samples: Record<string, unknown>[] = [
      { [T]: "a", [S]: "o1", [A]: "  이준\t" },
      { [T]: "b", [S]: "o3" },
      { [T]: "c", [S]: 7, [A]: "   " },
      { [T]: "d" },
      { [T]: "e", [S]: "o1", [A]: "\u00a0이준\u00a0" }, // NBSP — JS trim 은 지우고 Postgres \s 는 놓쳤다(리뷰 I-1)
      { [T]: "f", [S]: "o1", [A]: "\ufeff이준" }, // BOM
      { [T]: "g", [S]: "o1", [A]: "\u3000이준\u2028" }, // 전각 공백·줄 구분자
    ];
    await prisma.dbRow.createMany({ data: samples.map((props, i) => ({ databasePageId: boardId, props: props as object, position: i })) });

    // 마이그레이션과 같은 문자열(lib/taskColumnsSql.test 가 일치를 강제) — 이 테스트의 보드에만 돌린다.
    const scoped = `${REDERIVE_TASK_COLUMNS_SQL} AND t."databasePageId" = $1`;
    expect(await prisma.$executeRawUnsafe(scoped, boardId)).toBe(samples.length);
    expect(await prisma.$executeRawUnsafe(scoped, boardId)).toBe(0); // 멱등 — 이미 같은 행은 쓰지 않는다

    const props = await prisma.dbProperty.findMany({ where: { databasePageId: boardId }, orderBy: rows.taskPropOrder() });
    const lite = props.map((p) => ({ id: p.id, name: p.name, type: p.type as string }));
    const got = await prisma.dbRow.findMany({ where: { databasePageId: boardId }, orderBy: { position: "asc" } });
    for (const r of got) {
      expect({ statusOptionId: r.statusOptionId, assigneeText: r.assigneeText, taskColsKey: r.taskColsKey }).toEqual(
        cols.deriveTaskColumns(lite, r.props as Record<string, unknown>),
      );
    }
  });

  it("재계산은 키가 맞는데 칸만 낡은 행(새 코드를 거치지 않은 props 쓰기)을 바로잡는다(리뷰 I-2)", async () => {
    const S = `s-${stamp}`, A = `a-${stamp}`;
    const props = await prisma.dbProperty.findMany({ where: { databasePageId: boardId }, orderBy: rows.taskPropOrder() });
    const lite = props.map((p) => ({ id: p.id, name: p.name, type: p.type as string }));
    const key = cols.taskColsKey(lite);
    // 옛 바이너리 흉내: props 는 '할 일·이준' 인데 칸은 '완료·남' 그대로
    const r = await prisma.dbRow.create({ data: { databasePageId: boardId, props: { [S]: "o1", [A]: "이준" }, position: 20, statusOptionId: "o3", assigneeText: "남", taskColsKey: key } });
    const before = await rows.findTaskRows(boardId, lite, { closedOptionIds: ["o3"], assignee: "이준" });
    expect(before.some((x) => x.id === r.id)).toBe(false); // 보장 밖 — 빠른 경로에서 사라진다
    await prisma.$executeRawUnsafe(`${REDERIVE_TASK_COLUMNS_SQL} AND t."databasePageId" = $1`, boardId);
    const after = await rows.findTaskRows(boardId, lite, { closedOptionIds: ["o3"], assignee: "이준" });
    expect(after.some((x) => x.id === r.id)).toBe(true);
    await prisma.dbRow.delete({ where: { id: r.id } });
  });

  it("findTaskRows: 닫힌 옵션은 DB 가 빼고, 키가 다른 행은 통째로 온다", async () => {
    const S = `s-${stamp}`;
    await prisma.dbRow.create({ data: { databasePageId: boardId, props: { [S]: "o3" }, position: 10, taskColsKey: "stale|" } });
    const props = await prisma.dbProperty.findMany({ where: { databasePageId: boardId }, orderBy: rows.taskPropOrder() });
    const lite = props.map((p) => ({ id: p.id, name: p.name, type: p.type as string }));
    const out = await rows.findTaskRows(boardId, lite, { closedOptionIds: ["o3"] });
    expect(out.map((r) => r.position)).toEqual([0, 2, 3, 4, 5, 6, 10]); // 1(완료, 칸 있음)만 빠지고 10(낡은 키)은 JS 몫으로 남는다
  });
});

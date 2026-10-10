import { describe, it, expect, vi, afterEach } from "vitest";
import { buildProjectStats, type RawProject } from "@/lib/projects";

/* buildProjectStats: prisma에서 페치한 raw 프로젝트(+소속 페이지/행)를 받아
   카드용 ProjectStat[]로 집계하는 순수 함수. DB 없이 단위 테스트한다. */

const statusOptions = [
  { id: "s_todo", name: "할 일", color: "gray" },
  { id: "s_doing", name: "진행 중", color: "blue" },
  { id: "s_done", name: "완료", color: "green" },
];

function board(rows: Record<string, unknown>[], id = "board1") {
  return {
    id,
    kind: "database" as const,
    dbProperties: [
      { id: "p_name", name: "이름", type: "text", config: null },
      { id: "p_status", name: "상태", type: "select", config: { options: statusOptions } },
      { id: "p_assignee", name: "담당자", type: "text", config: null },
      { id: "p_due", name: "마감일", type: "date", config: null },
    ],
    dbRows: rows.map((props) => ({ props })),
  };
}

function doc(id: string) {
  return { id, kind: "doc" as const, dbProperties: [], dbRows: [] };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("buildProjectStats", () => {
  it("counts open/done tasks, status buckets, participants, and docs from a project's board", () => {
    const raw: RawProject[] = [
      {
        id: "proj1",
        name: "iOS 앱",
        short: "iOS",
        color: "blue",
        description: "데모",
        lead: { id: "u1", name: "이호준", image: null },
        pages: [
          board([
            { p_name: "A", p_status: "s_doing", p_assignee: "이호준" },
            { p_name: "B", p_status: "s_done", p_assignee: "김개발" },
            { p_name: "C", p_status: "s_todo", p_assignee: "이호준, 박디자인" },
          ]),
          doc("d1"),
          doc("d2"),
        ],
      },
    ];

    const [stat] = buildProjectStats(raw);

    expect(stat.taskCount).toBe(3);
    expect(stat.doneCount).toBe(1);
    expect(stat.openCount).toBe(2);
    expect(stat.boardPageId).toBe("board1");
    expect(stat.docCount).toBe(2);

    // 상태 버킷(순서 무관, 이름으로 조회)
    const bucket = (name: string) => stat.statusBuckets.find((b) => b.name === name)?.count ?? 0;
    expect(bucket("할 일")).toBe(1);
    expect(bucket("진행 중")).toBe(1);
    expect(bucket("완료")).toBe(1);

    // 참여자(고유)
    expect([...stat.participants].sort()).toEqual(["김개발", "박디자인", "이호준"]);
  });

  it("counts overdue and due-soon only for open tasks, relative to today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T12:00:00"));

    const raw: RawProject[] = [
      {
        id: "proj1",
        name: "P",
        short: null,
        color: "blue",
        description: null,
        lead: null,
        pages: [
          board([
            { p_name: "지연-열림", p_status: "s_doing", p_due: "2026-06-25" }, // 3일 지남 → overdue
            { p_name: "임박-열림", p_status: "s_todo", p_due: "2026-07-01" }, // 3일 뒤 → dueSoon
            { p_name: "지연-완료", p_status: "s_done", p_due: "2026-06-20" }, // 완료라 제외
            { p_name: "먼미래", p_status: "s_todo", p_due: "2026-09-01" }, // 7일 초과 → 둘 다 아님
          ]),
        ],
      },
    ];

    const [stat] = buildProjectStats(raw);

    expect(stat.overdueCount).toBe(1);
    expect(stat.dueSoonCount).toBe(1);
  });
});

describe("buildProjectStats archivedAt (F10)", () => {
  const base = { short: null, color: "blue", description: null, lead: null, pages: [] };
  it("보관 시각은 ISO 문자열, 활성은 null", () => {
    const [a, b, c] = buildProjectStats([
      { id: "a", name: "A", ...base, archivedAt: new Date("2026-10-09T00:00:00.000Z") },
      { id: "b", name: "B", ...base, archivedAt: null },
      { id: "c", name: "C", ...base },
    ]);
    expect(a.archivedAt).toBe("2026-10-09T00:00:00.000Z");
    expect(b.archivedAt).toBeNull();
    expect(c.archivedAt).toBeNull();
  });
});

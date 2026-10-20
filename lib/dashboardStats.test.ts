import { describe, it, expect } from "vitest";
import { buildDashboardStats } from "./dashboardStats";

const opt = (id: string, name: string, color = "gray") => ({ id, name, color });
const properties = [
  { id: "t", name: "이름", type: "text", config: null },
  { id: "s", name: "상태", type: "select", config: { options: [opt("todo", "할 일"), opt("doing", "진행 중", "blue"), opt("done", "완료", "green")] } },
  { id: "p", name: "우선순위", type: "select", config: { options: [opt("hi", "높음", "red"), opt("lo", "낮음")] } },
  { id: "a", name: "담당자", type: "text", config: null },
  { id: "d", name: "마감일", type: "date", config: null },
  { id: "x", name: "메모", type: "text", config: null },
];
const row = (id: string, props: Record<string, unknown>) => ({ id, props });

describe("buildDashboardStats (대시보드 통계 서버 집계, 감사 P-8)", () => {
  const rows = [
    row("r1", { t: "가", s: "todo", p: "hi", a: "민수, 지영", d: "2026-10-21", x: "긴 메모".repeat(100) }),
    row("r2", { t: "나", s: "doing", p: "hi", a: "민수", d: "2026-10-19" }),
    row("r3", { t: "다", s: "done", p: "lo", a: "지영", d: "2026-10-01" }),
    row("r4", { t: 7, s: "gone", a: "" }),
  ];
  const st = buildDashboardStats(properties, rows);

  it("상태: 옵션별 건수·미지정(없는 옵션 포함)·진행 중(이름 휴리스틱)·완료(마지막 옵션)", () => {
    expect(st.total).toBe(4);
    expect(st.status).toEqual({
      buckets: [
        { id: "todo", name: "할 일", color: "gray", count: 1 },
        { id: "doing", name: "진행 중", color: "blue", count: 1 },
        { id: "done", name: "완료", color: "green", count: 1 },
      ],
      unset: 1,
      inProgress: { name: "진행 중", count: 1 },
      done: { name: "완료", count: 1 },
    });
  });

  it("두 번째 분포는 우선순위, 담당자는 쉼표로 나눠 많은 순", () => {
    expect(st.second).toEqual({
      name: "우선순위",
      buckets: [
        { id: "hi", name: "높음", color: "red", count: 2 },
        { id: "lo", name: "낮음", color: "gray", count: 1 },
      ],
    });
    expect(st.assignees).toEqual([
      { name: "민수", count: 2 },
      { name: "지영", count: 2 },
    ]);
  });

  it("마감: 열린(완료 아닌) 행 중 날짜 문자열이 있는 것만, 제목·첫 담당자와 함께 — 날짜 계산은 화면(로컬 오늘)이 한다", () => {
    expect(st.dueOpen).toEqual([
      { id: "r1", title: "가", due: "2026-10-21", assignee: "민수" },
      { id: "r2", title: "나", due: "2026-10-19", assignee: "민수" },
    ]);
  });

  it("행 props 를 통째로 싣지 않는다(메모 같은 무관한 속성 없음)", () => {
    expect(JSON.stringify(st)).not.toContain("긴 메모");
  });

  it("역할 속성이 없으면 null·빈 배열", () => {
    const bare = buildDashboardStats([{ id: "t", name: "이름", type: "text", config: null }], [row("r", { t: "x" })]);
    expect(bare).toEqual({ total: 1, status: null, second: null, assignees: [], dueOpen: null });
  });

  it("진행 중 이름이 없으면 옵션이 3개 이상일 때 두 번째, 아니면 null", () => {
    const props2 = [
      { id: "t", name: "이름", type: "text", config: null },
      { id: "s", name: "status", type: "select", config: { options: [opt("a", "A"), opt("b", "B"), opt("c", "C")] } },
    ];
    expect(buildDashboardStats(props2, [row("r", { s: "b" })]).status?.inProgress).toEqual({ name: "B", count: 1 });
    const props3 = [props2[0], { ...props2[1], config: { options: [opt("a", "A"), opt("c", "C")] } }];
    expect(buildDashboardStats(props3, []).status?.inProgress).toBeNull();
  });
});

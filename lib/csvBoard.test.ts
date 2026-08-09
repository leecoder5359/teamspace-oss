import { describe, it, expect } from "vitest";
import { parseCsv, inferCsvType, parseDateCell, planBoardCsv, boardRowProps } from "@/lib/csvBoard";

describe("parseCsv", () => {
  it("헤더와 행을 셀로 나눈다", () => {
    expect(parseCsv("이름,상태\n로그인 수정,진행 중\n")).toEqual([
      ["이름", "상태"],
      ["로그인 수정", "진행 중"],
    ]);
  });

  it("따옴표 안의 콤마는 셀을 나누지 않는다", () => {
    expect(parseCsv('이름,태그\n"가, 나",프론트\n')).toEqual([
      ["이름", "태그"],
      ["가, 나", "프론트"],
    ]);
  });

  it("따옴표 안의 줄바꿈은 행을 나누지 않는다", () => {
    expect(parseCsv('이름,메모\n제목,"첫 줄\n둘째 줄"\n')).toEqual([
      ["이름", "메모"],
      ["제목", "첫 줄\n둘째 줄"],
    ]);
  });

  it('이중 따옴표("")는 따옴표 한 개다', () => {
    expect(parseCsv('이름\n"그는 ""좋다"" 고 했다"\n')).toEqual([["이름"], ['그는 "좋다" 고 했다']]);
  });

  it("BOM 과 CRLF 를 처리한다", () => {
    expect(parseCsv("﻿이름,상태\r\n가,나\r\n")).toEqual([
      ["이름", "상태"],
      ["가", "나"],
    ]);
  });

  it("마지막 개행이 빈 행을 만들지 않는다", () => {
    expect(parseCsv("a\nb\n")).toHaveLength(2);
    expect(parseCsv("a\nb")).toHaveLength(2);
  });

  it("빈 줄은 행으로 세지 않는다", () => {
    expect(parseCsv("a,b\n\n1,2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("빈 텍스트는 빈 목록", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("   \n")).toEqual([]);
  });

  it("셀 앞뒤 공백은 다듬되 따옴표 안은 그대로 둔다", () => {
    expect(parseCsv('a , b\n" 유지 ",x\n')).toEqual([
      ["a", "b"],
      [" 유지 ", "x"],
    ]);
  });
});

describe("parseDateCell", () => {
  it("ISO 날짜·시각을 YYYY-MM-DD 로", () => {
    expect(parseDateCell("2026-08-09")).toBe("2026-08-09");
    expect(parseDateCell("2026-08-09T15:00:00.000Z")).toBe("2026-08-09");
  });

  it("슬래시(연-월-일)를 읽는다", () => {
    expect(parseDateCell("2026/8/9")).toBe("2026-08-09");
  });

  it("노션 영문 월 이름을 읽는다", () => {
    expect(parseDateCell("August 9, 2026")).toBe("2026-08-09");
    expect(parseDateCell("August 9, 2026 3:00 PM")).toBe("2026-08-09");
    expect(parseDateCell("Sep 1, 2026")).toBe("2026-09-01");
  });

  it("한국식 표기를 읽는다", () => {
    expect(parseDateCell("2026년 8월 9일")).toBe("2026-08-09");
  });

  it("없는 날짜는 거절한다", () => {
    expect(parseDateCell("2026-02-31")).toBeNull();
    expect(parseDateCell("2026-13-01")).toBeNull();
  });

  it("날짜가 아닌 것은 null", () => {
    expect(parseDateCell("")).toBeNull();
    expect(parseDateCell("내일")).toBeNull();
    // 월/일/연 은 월·일 순서를 알 수 없으니 날짜로 보지 않는다(글자로 남겨 값을 잃지 않는다)
    expect(parseDateCell("08/09/2026")).toBeNull();
    // 노션 날짜 범위도 날짜 한 개가 아니라서 거절 — 열 전체가 글자가 된다
    expect(parseDateCell("August 9, 2026 → August 10, 2026")).toBeNull();
  });
});

describe("inferCsvType", () => {
  it("Yes/No·true/false 는 체크박스", () => {
    expect(inferCsvType(["Yes", "No", "Yes"])).toBe("checkbox");
    expect(inferCsvType(["true", "false", ""])).toBe("checkbox");
    expect(inferCsvType(["예", "아니오"])).toBe("checkbox");
  });

  it("숫자는 number (천단위 콤마 포함)", () => {
    expect(inferCsvType(["1", "2", "30"])).toBe("number");
    expect(inferCsvType(["-1.5", "2.25"])).toBe("number");
    expect(inferCsvType(["1,200", "980"])).toBe("number");
  });

  it("1/0 은 숫자로 본다 — 체크박스로 넘겨짚지 않는다", () => {
    expect(inferCsvType(["1", "0", "1"])).toBe("number");
  });

  it("날짜 표기가 전부면 date", () => {
    expect(inferCsvType(["2026-08-09", "2026-08-10"])).toBe("date");
    expect(inferCsvType(["August 9, 2026", ""])).toBe("date");
  });

  it("반복되는 소수 후보값은 select", () => {
    expect(inferCsvType(["할 일", "진행 중", "할 일", "완료", "진행 중"])).toBe("select");
  });

  it("값이 전부 다르면 select 가 아니다", () => {
    expect(inferCsvType(["가", "나", "다", "라"])).toBe("text");
  });

  it("콤마가 든 값은 다중 선택으로 보고 글자로 남긴다", () => {
    expect(inferCsvType(["버그, 프론트", "버그, 프론트", "백엔드", "백엔드"])).toBe("text");
  });

  it("긴 문장은 select 후보가 아니다", () => {
    const long = "이 문장은 select 옵션으로 쓰기에는 너무 길어서 글자 열로 남아야 한다 — 옵션은 짧은 라벨이다";
    expect(inferCsvType([long, long, long])).toBe("text");
  });

  it("빈 열은 text", () => {
    expect(inferCsvType([])).toBe("text");
    expect(inferCsvType(["", "", ""])).toBe("text");
  });

  it("한 행뿐이면 select 로 넘겨짚지 않는다", () => {
    expect(inferCsvType(["진행 중"])).toBe("text");
  });
});

describe("planBoardCsv", () => {
  const csv = [
    "이름,상태,마감일,진행률,완료",
    "로그인 수정,진행 중,2026-08-09,30,Yes",
    "회원가입,할 일,2026-08-12,0,No",
    "비번 찾기,진행 중,,10,No",
  ].join("\n");

  const board = planBoardCsv({ path: "boards/할 일.csv", text: csv, title: "할 일", projectName: "TeamSpace 개발" })!;

  it("제목·프로젝트·경로를 그대로 담는다", () => {
    expect(board.title).toBe("할 일");
    expect(board.projectName).toBe("TeamSpace 개발");
    expect(board.path).toBe("boards/할 일.csv");
  });

  it("열 타입을 추론한다", () => {
    expect(board.columns.map((c) => [c.name, c.type])).toEqual([
      ["이름", "text"],
      ["상태", "select"],
      ["마감일", "date"],
      ["진행률", "number"],
      ["완료", "checkbox"],
    ]);
  });

  it("select 후보값을 등장 순서로 모은다", () => {
    expect(board.columns[1].options).toEqual(["진행 중", "할 일"]);
  });

  it("셀을 타입에 맞는 값으로 바꾼다", () => {
    expect(board.rows[0].cells).toEqual(["로그인 수정", "진행 중", "2026-08-09", 30, true]);
    expect(board.rows[2].cells).toEqual(["비번 찾기", "진행 중", null, 10, false]);
  });

  it("첫 열은 제목 열이라 값이 반복돼도 text 로 둔다", () => {
    const b = planBoardCsv({
      path: "a.csv",
      text: "이름,x\n같은 값,1\n같은 값,2\n같은 값,3\n",
      title: "a",
      projectName: null,
    })!;
    expect(b.columns[0].type).toBe("text");
  });

  it("열 이름이 겹치면 번호를 붙이고 경고한다", () => {
    const b = planBoardCsv({ path: "a.csv", text: "이름,이름\n가,나\n", title: "a", projectName: null })!;
    expect(b.columns.map((c) => c.name)).toEqual(["이름", "이름 (2)"]);
    expect(b.warnings.join(" ")).toContain("이름");
  });

  it("빈 열 이름은 자리 이름을 준다", () => {
    const b = planBoardCsv({ path: "a.csv", text: "이름,,메모\n가,나,다\n", title: "a", projectName: null })!;
    expect(b.columns[1].name).toBe("열 2");
  });

  it("셀이 열보다 적으면 빈 값으로, 많으면 버리고 경고한다", () => {
    const b = planBoardCsv({ path: "a.csv", text: "a,b\n1\n1,2,3\n", title: "a", projectName: null })!;
    expect(b.rows[0].cells).toEqual(["1", null]);
    expect(b.rows[1].cells).toHaveLength(2);
    expect(b.warnings.some((w) => w.includes("열 수"))).toBe(true);
  });

  it("전부 빈 행은 버린다", () => {
    const b = planBoardCsv({ path: "a.csv", text: "a,b\n1,2\n,\n", title: "a", projectName: null })!;
    expect(b.rows).toHaveLength(1);
  });

  it("헤더만 있으면 빈 보드를 계획한다", () => {
    const b = planBoardCsv({ path: "a.csv", text: "이름,상태\n", title: "a", projectName: null })!;
    expect(b.columns).toHaveLength(2);
    expect(b.rows).toEqual([]);
  });

  it("내용이 없으면 null (보드를 만들지 않는다)", () => {
    expect(planBoardCsv({ path: "a.csv", text: "", title: "a", projectName: null })).toBeNull();
    expect(planBoardCsv({ path: "a.csv", text: "\n\n", title: "a", projectName: null })).toBeNull();
  });

  it("열이 아예 없는 헤더는 null", () => {
    expect(planBoardCsv({ path: "a.csv", text: ",,\n,,\n", title: "a", projectName: null })).toBeNull();
  });

  it("행 상한을 넘으면 자르고 경고한다", () => {
    const rows = Array.from({ length: 5 }, (_, i) => `행 ${i},x`).join("\n");
    const b = planBoardCsv({ path: "a.csv", text: `a,b\n${rows}\n`, title: "a", projectName: null, maxRows: 3 })!;
    expect(b.rows).toHaveLength(3);
    expect(b.warnings.some((w) => w.includes("3"))).toBe(true);
  });

  it("첫 열(제목)에 콤마가 있어도 다중 선택으로 경고하지 않는다", () => {
    const b = planBoardCsv({
      path: "a.csv",
      text: '이름,수\n"가, 나",1\n"가, 나",2\n',
      title: "a",
      projectName: null,
    })!;
    expect(b.warnings.filter((w) => w.includes("다중 선택"))).toEqual([]);
  });

  it("노션 데이터베이스 CSV — 다중 선택은 글자로, 체크박스는 Yes/No 로 읽는다", () => {
    const notion = [
      "Name,Status,Tags,Due,Done",
      'Fix login,In progress,"Bug, Frontend","August 9, 2026",No',
      'Signup,Todo,"Bug, Frontend","August 12, 2026",Yes',
      "Reset pw,In progress,Backend,,No",
    ].join("\n");
    const b = planBoardCsv({ path: "Tasks abc.csv", text: notion, title: "Tasks", projectName: null })!;
    expect(b.columns.map((c) => c.type)).toEqual(["text", "select", "text", "date", "checkbox"]);
    expect(b.rows[0].cells).toEqual(["Fix login", "In progress", "Bug, Frontend", "2026-08-09", false]);
    expect(b.warnings.some((w) => w.includes("Tags"))).toBe(true);
  });
});

describe("planBoardCsv — workspace.json 이 알려준 열 타입(우리 export 왕복)", () => {
  it("행이 적어 추론이 못 맞히는 select 도 색인이 있으면 살린다", () => {
    const b = planBoardCsv({
      path: "boards/할 일.csv",
      text: "이름,상태\n가,진행 중\n",
      title: "할 일",
      projectName: null,
      known: [
        { name: "이름", type: "text" },
        { name: "상태", type: "select", options: ["할 일", "진행 중", "완료"] },
      ],
    })!;
    expect(b.columns[1].type).toBe("select");
    // 옵션은 CSV 에 안 나온 것까지 원래 보드 그대로 복원한다
    expect(b.columns[1].options).toEqual(["할 일", "진행 중", "완료"]);
    expect(b.rows[0].cells[1]).toBe("진행 중");
  });

  it("만들 수 없는 타입(multiselect·person·relation)은 글자 열로 낮춘다", () => {
    const b = planBoardCsv({
      path: "a.csv",
      text: "이름,태그,담당,연결\n가,x,나,1\n",
      title: "a",
      projectName: null,
      known: [
        { name: "이름", type: "text" },
        { name: "태그", type: "multiselect" },
        { name: "담당", type: "person" },
        { name: "연결", type: "relation" },
      ],
    })!;
    expect(b.columns.map((c) => c.type)).toEqual(["text", "text", "text", "text"]);
    expect(b.warnings.some((w) => w.includes("태그"))).toBe(true);
  });

  it("색인에 없는 열은 그대로 추론한다", () => {
    const b = planBoardCsv({
      path: "a.csv",
      text: "이름,새 열\n가,2026-08-09\n",
      title: "a",
      projectName: null,
      known: [{ name: "이름", type: "text" }],
    })!;
    expect(b.columns[1].type).toBe("date");
  });

  it("색인이 date 라고 하는데 값이 날짜가 아니면 글자로 물러난다 — 값을 잃지 않는다", () => {
    const b = planBoardCsv({
      path: "a.csv",
      text: "이름,마감\n가,다음 주\n나,다음 주\n",
      title: "a",
      projectName: null,
      known: [
        { name: "이름", type: "text" },
        { name: "마감", type: "date" },
      ],
    })!;
    expect(b.columns[1].type).toBe("text");
    expect(b.rows[0].cells[1]).toBe("다음 주");
  });
});

describe("boardRowProps", () => {
  const board = planBoardCsv({
    path: "a.csv",
    text: "이름,상태,수\n가,진행 중,1\n나,완료,2\n다,진행 중,3\n",
    title: "a",
    projectName: null,
  })!;

  it("열 순서의 속성 id 로 행 props 를 만든다", () => {
    const rows = boardRowProps(board, ["p1", "p2", "p3"], { "1 진행 중": "o1", "1 완료": "o2" });
    expect(rows).toEqual([
      { p1: "가", p2: "o1", p3: 1 },
      { p1: "나", p2: "o2", p3: 2 },
      { p1: "다", p2: "o1", p3: 3 },
    ]);
  });

  it("옵션 id 를 못 찾은 select 는 값을 비운다 — 옵션 id 자리에 이름을 넣지 않는다", () => {
    const rows = boardRowProps(board, ["p1", "p2", "p3"], {});
    expect(rows[0].p2).toBeNull();
  });

  it("빈 셀은 키를 만들지 않는다", () => {
    const b = planBoardCsv({ path: "a.csv", text: "이름,메모\n가,\n", title: "a", projectName: null })!;
    expect(boardRowProps(b, ["p1", "p2"], {})).toEqual([{ p1: "가" }]);
  });
});

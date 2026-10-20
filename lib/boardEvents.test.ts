import { describe, it, expect } from "vitest";
import { attachBoardIds, boardEventMatches } from "./boardEvents";

describe("attachBoardIds (서버: SSE activity 에 보드 id 싣기)", () => {
  it("task 활동은 행 id → 보드 id, 보드 자체 활동은 targetId 가 곧 보드 id, 나머지는 없음", () => {
    const acts = [
      { verb: "updated", targetType: "task", targetId: "r1" },
      { verb: "deleted", targetType: "board", targetId: "b9" },
      { verb: "updated", targetType: "doc", targetId: "d1" },
      { verb: "updated", targetType: "task", targetId: "gone" },
      { verb: "requested", targetType: "approval", targetId: null },
    ];
    expect(attachBoardIds(acts, new Map([["r1", "b1"]]))).toEqual([
      { verb: "updated", targetType: "task", targetId: "r1", boardId: "b1" },
      { verb: "deleted", targetType: "board", targetId: "b9", boardId: "b9" },
      { verb: "updated", targetType: "doc", targetId: "d1", boardId: null },
      { verb: "updated", targetType: "task", targetId: "gone", boardId: null },
      { verb: "requested", targetType: "approval", targetId: null, boardId: null },
    ]);
  });
});

describe("boardEventMatches (클라: 이 보드가 다시 읽을 이벤트인가)", () => {
  const board = { id: "b1", rowIds: new Set(["r1", "r2"]), relatedBoardIds: new Set(["b2"]) };
  const act = (e: Record<string, unknown>) => ({ type: "activity" as const, ...e });

  it("내 보드의 태스크·내 행·관계 대상 보드의 태스크면 true", () => {
    expect(boardEventMatches(act({ targetType: "task", targetId: "new", boardId: "b1" }), board)).toBe(true);
    // 다른 보드로 옮겨 간 내 행 — 서버의 boardId 는 옮겨 간 보드지만 targetId 가 내 행이다
    expect(boardEventMatches(act({ verb: "moved", targetType: "task", targetId: "r2", boardId: "bX" }), board)).toBe(true);
    expect(boardEventMatches(act({ targetType: "task", targetId: "x", boardId: "b2" }), board)).toBe(true);
  });

  it("다른 보드의 태스크·무관한 문서·알림이면 false", () => {
    expect(boardEventMatches(act({ targetType: "task", targetId: "x", boardId: "bX" }), board)).toBe(false);
    expect(boardEventMatches(act({ targetType: "doc", targetId: "d1", boardId: null }), board)).toBe(false);
    expect(boardEventMatches(act({ targetType: "decision", targetId: "dc" }), board)).toBe(false);
    expect(boardEventMatches({ type: "notification" }, board)).toBe(false);
  });

  it("이 보드 페이지 자체(이름 변경·삭제·보관)면 true", () => {
    for (const targetType of ["board", "doc", "page"]) {
      expect(boardEventMatches(act({ targetType, targetId: "b1" }), board)).toBe(true);
    }
  });

  it("id 를 모르는 태스크 활동(구 서버·본문 깨짐)은 보수적으로 true — 본문 없는 activity 도", () => {
    expect(boardEventMatches(act({ verb: "updated", targetType: "task" }), board)).toBe(true);
    expect(boardEventMatches(act({ targetType: "task", targetId: "x" }), board)).toBe(true); // boardId 필드 자체가 없음 = 구 서버
    expect(boardEventMatches({ type: "activity" }, board)).toBe(true);
  });
});

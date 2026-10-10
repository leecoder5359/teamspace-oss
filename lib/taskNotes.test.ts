import { describe, it, expect } from "vitest";
import { isTaskNote, TASK_NOTE_EXCLUDE } from "./taskNotes";
describe("isTaskNote", () => {
  it("docType 우선, 없으면 제목 접두어", () => {
    expect(isTaskNote({ docType: "task_note", title: "x" })).toBe(true);
    expect(isTaskNote({ docType: "design", title: "[태스크 설명] y" })).toBe(false);
    expect(isTaskNote({ docType: null, title: "[태스크 설명] y" })).toBe(true);
    expect(isTaskNote({ title: "설계" })).toBe(false);
  });
  it("Prisma where 조각은 null 과 task_note 아님을 OR 로 묶는다", () => {
    expect(TASK_NOTE_EXCLUDE.OR).toHaveLength(2);
  });
});

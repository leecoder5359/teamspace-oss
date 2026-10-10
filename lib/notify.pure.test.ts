// vi.mock 없이 로드된다 — prisma·slack 이 평가되면 DB 연결이 필요해진다.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  selectRules,
  statusOf,
  taskAssignedMessage,
  taskCreatedMessage,
  taskDueInboxMessage,
  taskDueMessage,
  taskStatusMessage,
  titleOf,
  type PropLite,
} from "./notify.pure";

const props: PropLite[] = [
  { id: "t", name: "이름", type: "text", config: null },
  { id: "s", name: "상태", type: "select", config: { options: [{ id: "o1", name: "진행" }, { id: "o2", name: "완료" }] } },
];

describe("notify.pure 의존 경계", () => {
  it("prisma·slack·activity 를 import 하지 않는다", () => {
    const src = readFileSync(new URL("./notify.pure.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/^import\s.*from\s+["'](@\/|node:|\.\/)/m);
  });
});

describe("notify.pure 동작", () => {
  it("selectRules: 프로젝트 규칙 우선, 없으면 전역", () => {
    const rules = [{ projectId: null, n: 1 }, { projectId: "p", n: 2 }];
    expect(selectRules(rules, "p")).toEqual([{ projectId: "p", n: 2 }]);
    expect(selectRules(rules, "q")).toEqual([{ projectId: null, n: 1 }]);
    expect(selectRules(rules, null)).toEqual([{ projectId: null, n: 1 }]);
  });
  it("titleOf / statusOf", () => {
    expect(titleOf(props, { t: "할 일" })).toBe("할 일");
    expect(titleOf(props, {})).toBe("(제목 없음)");
    expect(statusOf(props, { s: "o2" })).toBe("완료");
    expect(statusOf(props, { s: "zz" })).toBeNull();
    expect(statusOf([props[0]], {})).toBeNull();
  });
  it("메시지 문자열은 기존 문구와 동일", () => {
    expect(taskCreatedMessage("A")).toBe("🆕 새 태스크: A");
    expect(taskStatusMessage("A", "진행", "완료")).toBe("🔄 A · 상태: 진행 → 완료");
    expect(taskStatusMessage("A", null, "완료")).toBe("🔄 A · 상태: — → 완료");
    expect(taskAssignedMessage("A", "나", "너")).toBe("👤 A · 담당: 나 → 너");
    expect(taskAssignedMessage("A", null, "너")).toBe("👤 A · 담당: 너");
    expect(taskDueMessage("A", "2026-10-01", true)).toBe("⏰ 마감 지남: A (마감 2026-10-01)");
    expect(taskDueMessage("A", "2026-10-09", false)).toBe("📅 오늘 마감: A (마감 2026-10-09)");
    expect(taskDueInboxMessage("A", false)).toBe("📅 오늘 마감: A");
  });
});

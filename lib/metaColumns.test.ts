// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { metaCell, META_COLUMNS, type DbRow } from "@/components/DatabaseView";

/**
 * 격차 C3: DbRow 에 createdAt·updatedAt·updatedById 가 이미 저장되고 있는데
 * 어떤 화면도 보여주지 않았다. createdById 는 아예 없어서 '만든 사람' 열은
 * 만들 수조차 없었다(2026-08-08 컬럼 추가).
 */
const users = { u1: "이호준", u2: "claude-agent" };
const row = (over: Partial<DbRow> = {}): DbRow => ({
  id: "r1",
  props: {},
  position: 0,
  createdAt: "2026-08-08T01:02:03.000Z",
  updatedAt: "2026-08-08T04:05:06.000Z",
  createdById: "u1",
  updatedById: "u2",
  ...over,
});

describe("metaCell", () => {
  it("네 가지 메타 열을 모두 낸다", () => {
    expect(META_COLUMNS.map((c) => c.key)).toEqual(["createdAt", "updatedAt", "createdBy", "updatedBy"]);
  });

  it("사람 이름으로 풀어 쓴다 — id 를 그대로 보여주지 않는다", () => {
    expect(metaCell(row(), "createdBy", users)).toBe("이호준");
    expect(metaCell(row(), "updatedBy", users)).toBe("claude-agent");
  });

  it("이름을 못 찾으면 id 라도 보여준다(빈칸보다 낫다)", () => {
    expect(metaCell(row({ updatedById: "unknown" }), "updatedBy", users)).toBe("unknown");
  });

  it("값이 없으면 빈 문자열 — 없는 걸 지어내지 않는다", () => {
    expect(metaCell(row({ createdById: null }), "createdBy", users)).toBe("");
    expect(metaCell(row({ updatedById: null }), "updatedBy", users)).toBe("");
    expect(metaCell(row({ createdAt: undefined }), "createdAt", users)).toBe("");
  });

  it("시각은 사람이 읽는 형태로 바꾼다(ISO 원문 노출 금지)", () => {
    const s = metaCell(row(), "createdAt", users);
    expect(s).not.toContain("T");
    expect(s).not.toContain("Z");
    expect(s.length).toBeGreaterThan(0);
  });

  it("createdById 가 없는 옛 행도 터지지 않는다", () => {
    const legacy: DbRow = { id: "old", props: {}, position: 0 };
    for (const c of META_COLUMNS) expect(metaCell(legacy, c.key, users)).toBe("");
  });
});

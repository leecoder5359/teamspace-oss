import { describe, it, expect } from "vitest";
import { planRowMove, type MoveProp } from "./rowMove";

const sel = (id: string, name: string, options: [string, string, string?][]): MoveProp => ({
  id,
  name,
  type: "select",
  config: { options: options.map(([oid, oname, color]) => ({ id: oid, name: oname, ...(color ? { color } : {}) })) },
});

const SRC: MoveProp[] = [
  { id: "s-title", name: "이름", type: "text" },
  sel("s-status", "상태", [["s-todo", "할 일", "gray"], ["s-doing", "진행 중", "blue"], ["s-review", "검토", "purple"]]),
  { id: "s-due", name: "마감일", type: "date" },
  { id: "s-est", name: "추정", type: "number" },
  { id: "s-done", name: "확인", type: "checkbox" },
];

const TGT: MoveProp[] = [
  { id: "t-title", name: "이름", type: "text" },
  sel("t-status", "상태", [["t-todo", "할 일"], ["t-doing", "진행 중"]]),
  { id: "t-due", name: "마감일", type: "date" },
  { id: "t-est", name: "추정", type: "number" },
  { id: "t-done", name: "확인", type: "checkbox" },
];

let n = 0;
const newId = () => `new-${++n}`;

describe("planRowMove", () => {
  it("같은 이름·타입이면 값을 그대로 옮긴다", () => {
    const r = planRowMove({
      source: SRC,
      target: TGT,
      props: { "s-title": "작업", "s-due": "2026-09-20", "s-est": 3, "s-done": true },
      newId,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.props).toEqual({ "t-title": "작업", "t-due": "2026-09-20", "t-est": 3, "t-done": true });
    expect(r.mapped.map((m) => m.name)).toEqual(["이름", "마감일", "추정", "확인"]);
    expect(r.dropped).toEqual([]);
  });

  it("select 는 옵션 이름으로 대상 옵션 id 에 매핑한다", () => {
    const r = planRowMove({ source: SRC, target: TGT, props: { "s-title": "a", "s-status": "s-doing" }, newId });
    expect(r.ok && r.props["t-status"]).toBe("t-doing");
  });

  it("대상에 없는 옵션은 기본적으로 버리고 보고한다", () => {
    const r = planRowMove({ source: SRC, target: TGT, props: { "s-title": "a", "s-status": "s-review" }, newId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.props).not.toHaveProperty("t-status");
    expect(r.dropped).toEqual([{ name: "상태", type: "select", reason: expect.stringContaining("검토"), value: "검토" }]);
    expect(r.createdOptions).toEqual([]);
  });

  it("createMissingOptions 면 옵션을 만들어 붙인다(색 유지)", () => {
    const r = planRowMove({
      source: SRC,
      target: TGT,
      props: { "s-title": "a", "s-status": "s-review" },
      createMissingOptions: true,
      newId: () => "opt-x",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.props["t-status"]).toBe("opt-x");
    expect(r.createdOptions).toEqual([{ property: "상태", propertyId: "t-status", option: { id: "opt-x", name: "검토", color: "purple" } }]);
    expect(r.dropped).toEqual([]);
  });

  it("원본 옵션 id 가 원본 설정에 없으면(끊긴 값) 버린다", () => {
    const r = planRowMove({ source: SRC, target: TGT, props: { "s-title": "a", "s-status": "ghost" }, newId });
    expect(r.ok && r.dropped[0]).toMatchObject({ name: "상태", value: "ghost" });
    expect(r.ok && r.props).not.toHaveProperty("t-status");
  });

  it("multiselect 는 값마다 이름으로 매핑하고, 없는 것만 따로 보고한다", () => {
    const src: MoveProp[] = [SRC[0], { ...sel("s-tags", "태그", [["a", "버그"], ["b", "프론트", "red"]]), type: "multiselect" }];
    const tgt: MoveProp[] = [TGT[0], { ...sel("t-tags", "태그", [["x", "버그"]]), type: "multiselect" }];
    const dropped = planRowMove({ source: src, target: tgt, props: { "s-title": "a", "s-tags": ["a", "b"] }, newId });
    expect(dropped.ok && dropped.props["t-tags"]).toEqual(["x"]);
    expect(dropped.ok && dropped.dropped[0]).toMatchObject({ name: "태그", type: "multiselect", value: ["프론트"] });

    const created = planRowMove({
      source: src,
      target: tgt,
      props: { "s-title": "a", "s-tags": ["a", "b", "b"] },
      createMissingOptions: true,
      newId: () => "y",
    });
    expect(created.ok && created.props["t-tags"]).toEqual(["x", "y"]);
    expect(created.ok && created.createdOptions).toHaveLength(1);
  });

  it("relation 은 대상 보드(targetDatabaseId)가 같을 때만 옮긴다", () => {
    const src: MoveProp[] = [
      SRC[0],
      { id: "s-docs", name: "관련", type: "relation", config: { targetDatabaseId: "board-X" } },
      { id: "s-dep", name: "선행 태스크", type: "relation", config: { targetDatabaseId: "board-SRC" } },
    ];
    const tgt: MoveProp[] = [
      TGT[0],
      { id: "t-docs", name: "관련", type: "relation", config: { targetDatabaseId: "board-X" } },
      { id: "t-dep", name: "선행 태스크", type: "relation", config: { targetDatabaseId: "board-TGT" } },
    ];
    const r = planRowMove({ source: src, target: tgt, props: { "s-title": "a", "s-docs": ["r1", "r2"], "s-dep": ["r9"] }, newId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.props["t-docs"]).toEqual(["r1", "r2"]);
    expect(r.props).not.toHaveProperty("t-dep");
    expect(r.dropped).toEqual([{ name: "선행 태스크", type: "relation", reason: expect.stringContaining("대상 보드"), value: ["r9"] }]);
  });

  it("같은 이름·타입 상대가 없으면 버린다(타입 불일치 포함)", () => {
    const tgt: MoveProp[] = [TGT[0], { id: "t-est", name: "추정", type: "text" }];
    const r = planRowMove({ source: SRC, target: tgt, props: { "s-title": "a", "s-est": 5, "s-due": "2026-01-01" }, newId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.props).toEqual({ "t-title": "a" });
    expect(r.dropped.map((d) => [d.name, d.type])).toEqual([["마감일", "date"], ["추정", "number"]]);
    expect(r.dropped[1].reason).toContain("같은 이름·타입");
  });

  it("빈 값(undefined·null·빈 문자열·빈 배열)은 매핑도 보고도 하지 않는다", () => {
    const r = planRowMove({
      source: [...SRC, { id: "s-rel", name: "관련", type: "relation", config: { targetDatabaseId: "x" } }],
      target: [TGT[0]],
      props: { "s-title": "a", "s-status": "", "s-due": null, "s-rel": [] },
      newId,
    });
    expect(r.ok && r.dropped).toEqual([]);
    expect(r.ok && r.mapped).toEqual([{ name: "이름", type: "text" }]);
  });

  it("checkbox false 는 빈 값이 아니라 옮긴다", () => {
    const r = planRowMove({ source: SRC, target: TGT, props: { "s-title": "a", "s-done": false }, newId });
    expect(r.ok && r.props["t-done"]).toBe(false);
  });

  it("원본 보드에 없는 props 키(고아)는 조용히 무시한다", () => {
    const r = planRowMove({ source: SRC, target: TGT, props: { "s-title": "a", orphan: "x" }, newId });
    expect(r.ok && r.dropped).toEqual([]);
  });

  it("제목 속성은 이름이 달라도 대상의 제목(text) 속성으로 옮긴다", () => {
    const tgt: MoveProp[] = [{ id: "t-name", name: "Name", type: "text" }, ...TGT.slice(1)];
    const r = planRowMove({ source: SRC, target: tgt, props: { "s-title": "작업" }, newId });
    expect(r.ok && r.props).toEqual({ "t-name": "작업" });
    expect(r.ok && r.mapped).toEqual([{ name: "이름", type: "text", to: "Name" }]);
  });

  it("제목 폴백은 이미 같은 이름으로 매핑된 대상 속성을 가로채지 않는다", () => {
    const src: MoveProp[] = [{ id: "s-t", name: "제목", type: "text" }, { id: "s-memo", name: "메모", type: "text" }];
    const tgt: MoveProp[] = [{ id: "t-memo", name: "메모", type: "text" }];
    const r = planRowMove({ source: src, target: tgt, props: { "s-t": "작업", "s-memo": "m" }, newId });
    expect(r.ok).toBe(false);
  });

  it("대상에 제목(text) 속성이 없으면 거부한다", () => {
    const tgt: MoveProp[] = TGT.slice(1);
    const r = planRowMove({ source: SRC, target: tgt, props: { "s-title": "작업", "s-est": 1 }, newId });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("제목");
    expect(r.dropped.some((d) => d.name === "이름")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { actionCount, affectedIds, cardBody, extractJson, isEmptyProposal, mergeProposals, normalizeScopeTo, validateProposal, type ValidateLesson } from "./proposal";

const L = (id: string, o: Partial<ValidateLesson> = {}): ValidateLesson => ({ id, userId: null, projectId: null, stack: null, mode: "default", keywords: [], ...o });
const lessons = new Map(
  [L("a"), L("b"), L("c"), L("req", { mode: "required" }), L("mine", { userId: "u2" }), L("kw", { mode: "ondemand" }), L("kwfull", { mode: "ondemand", keywords: ["x1"] }), L("proj", { projectId: "P1" })].map((l) => [l.id, l]),
);
const projects = [{ id: "P1", name: "반장" }, { id: "P2", name: "로요" }];
const ctx = { lessons, projects };

describe("extractJson", () => {
  it("코드펜스·앞뒤 잡담을 걷어 낸다", () => {
    expect(extractJson('여기요\n```json\n{"drops":[]}\n```\n끝')).toEqual({ drops: [] });
    expect(extractJson('결과: {"a":1} 입니다')).toEqual({ a: 1 });
  });
  it("못 읽으면 null", () => {
    expect(extractJson("{ 깨진")).toBeNull();
    expect(extractJson(null)).toBeNull();
    expect(extractJson("JSON 없음")).toBeNull();
  });
});

describe("validateProposal — 잘못된 항목은 걸러 낸다", () => {
  it("최상위가 객체가 아니면 빈 제안", () => {
    expect(isEmptyProposal(validateProposal("nope", ctx))).toBe(true);
    expect(isEmptyProposal(validateProposal({ merges: "x" }, ctx))).toBe(true);
  });

  it("모양이 틀린 항목·모르는 id·개인 레슨·required 삭제를 버린다", () => {
    const p = validateProposal(
      {
        drops: [{ id: "a", reason: "낡음" }, { id: "zzz" }, { id: "mine" }, { id: "req" }, { nope: 1 }, "str"],
        merges: [
          { keepId: "b", mergeIds: ["c", "req", "mine"], newTitle: "합침", newBody: "본문", reason: "중복" },
          { keepId: "b", mergeIds: [], newTitle: "x", newBody: "y" },
          { keepId: "c", mergeIds: ["a"], newTitle: "", newBody: "y" },
        ],
      },
      ctx,
    );
    expect(p.merges).toEqual([{ keepId: "b", mergeIds: ["c"], newTitle: "합침", newBody: "본문", reason: "중복" }]);
    expect(p.drops).toEqual([{ id: "a", reason: "낡음" }]);
  });

  it("이미 지워질 레슨·남길 레슨을 다른 항목이 건드리지 못한다", () => {
    const p = validateProposal(
      {
        merges: [{ keepId: "a", mergeIds: ["b"], newTitle: "t", newBody: "b" }],
        drops: [{ id: "b" }, { id: "a" }],
        scopeFixes: [{ id: "b", to: "global" }],
        required: [{ id: "b", to: "required" }],
      },
      ctx,
    );
    expect(p.drops).toEqual([]);
    expect(p.scopeFixes).toEqual([]);
    expect(p.required).toEqual([]);
  });

  it("required 변경 — 바뀌는 것만, to 기본값은 required", () => {
    const p = validateProposal({ required: [{ id: "a" }, { id: "req", to: "default", reason: "많음" }, { id: "req", to: "required" }, { id: "b", to: "weird" }] }, ctx);
    expect(p.required).toEqual([
      { id: "a", to: "required", reason: "" },
      { id: "req", to: "default", reason: "많음" },
    ]);
  });

  it("키워드 채움 — 빈 레슨에만, 잘못된 단어는 개별로 버리고 소문자화", () => {
    const p = validateProposal({ ondemand: [{ id: "kw", keywords: ["Slack", "x", "슬랙 카드", "slack"] }, { id: "kwfull", keywords: ["abc"] }, { id: "kw", keywords: ["dup"] }] }, ctx);
    expect(p.ondemand).toEqual([{ id: "kw", keywords: ["slack", "슬랙 카드"], reason: "" }]);
  });

  it("범위 변경 — 이름·(id)·id·stack 을 정규형으로, 같은 범위·모르는 프로젝트는 버림", () => {
    const p = validateProposal(
      {
        scopeFixes: [
          { id: "a", to: "project:반장 (P1)" },
          { id: "b", to: "project:로요" },
          { id: "c", to: "project:없음" },
          { id: "proj", to: "project:P1" },
          { id: "kw", to: "stack:Next" },
        ],
      },
      ctx,
    );
    expect(p.scopeFixes.map((s) => [s.id, s.to])).toEqual([
      ["a", "project:P1"],
      ["b", "project:P2"],
      ["kw", "stack:next"],
    ]);
  });

  it("allowedIds 밖의 id 는 버린다(그 호출에 보여 주지 않은 레슨)", () => {
    const p = validateProposal({ drops: [{ id: "a" }, { id: "b" }] }, { ...ctx, allowedIds: new Set(["a"]) });
    expect(p.drops.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("mergeProposals·요약", () => {
  it("덩어리 사이 충돌(같은 레슨 두 번 삭제)을 다시 거른다", () => {
    const p = mergeProposals(
      [
        { merges: [], drops: [{ id: "a", reason: "1" }], review: [], required: [], ondemand: [], scopeFixes: [] },
        { merges: [{ keepId: "b", mergeIds: ["a"], newTitle: "t", newBody: "b", reason: "" }], drops: [{ id: "a", reason: "2" }], review: [{ id: "c", reason: "?" }], required: [], ondemand: [], scopeFixes: [] },
      ],
      ctx,
    );
    // merge 가 먼저 처리돼 a 를 흡수하고, drop a 는 중복이라 빠진다
    expect(p.merges).toHaveLength(1);
    expect(p.drops).toEqual([]);
    expect(actionCount(p)).toBe(1);
    expect(affectedIds(p).sort()).toEqual(["a", "b"]);
    const body = cardBody(p, { weekKey: "2026-W42", runId: "run1", titles: new Map([["b", "남길 레슨"]]), link: "/settings#lesson-hygiene" });
    expect(body).toContain("병합 1건(흡수 1개)");
    expect(body).toContain("남길 레슨");
    expect(body).toContain("/settings#lesson-hygiene");
    expect(body).toContain("revert run1");
  });

  it("normalizeScopeTo", () => {
    expect(normalizeScopeTo("전역", projects)).toBe("global");
    expect(normalizeScopeTo("team", projects)).toBeNull();
  });
});

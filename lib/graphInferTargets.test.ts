import { describe, expect, it } from "vitest";
import { selectInferTargets } from "./graphInferTargets";

const weak = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-06-01T00:00:00Z");
const tried = (...ids: string[]) => new Map(ids.map((id) => [id, T0] as const));

describe("selectInferTargets", () => {
  it("retryBefore 없음: 이미 시도한 문서는 건너뛴다", () => {
    const r = selectInferTargets(weak, tried("a", "c"), { limit: 10 });
    expect(r.batch.map((x) => x.id)).toEqual(["b", "d", "e"]);
    expect(r.remaining).toBe(0);
  });
  it("retryBefore 이후면 이전에 시도한 문서도 후보", () => {
    const r = selectInferTargets(weak, tried("a", "c"), { retryBefore: T1, limit: 10 });
    expect(r.batch.map((x) => x.id)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("retryBefore 이후에 시도한 문서는 건너뛴다(같은 실행에서 한 번만)", () => {
    const m = new Map([["a", T0], ["b", T1]]);
    const r = selectInferTargets(weak, m, { retryBefore: new Date("2026-03-01T00:00:00Z"), limit: 10 });
    expect(r.batch.map((x) => x.id)).toEqual(["a", "c", "d", "e"]);
  });
  it("시도 시각이 retryBefore 와 같으면 건너뛴다", () => {
    const r = selectInferTargets(weak, tried("a"), { retryBefore: T0, limit: 10 });
    expect(r.batch.map((x) => x.id)).toEqual(["b", "c", "d", "e"]);
  });
  it("limit 이 batch 를 자르고 remaining = 후보 − batch", () => {
    const r = selectInferTargets(weak, tried("a"), { limit: 2 });
    expect(r.batch.map((x) => x.id)).toEqual(["b", "c"]);
    expect(r.remaining).toBe(2);
  });
  it("전부 시도했으면 빈 batch·remaining 0", () => {
    const r = selectInferTargets(weak, tried(...weak.map((w) => w.id)), { limit: 5 });
    expect(r).toEqual({ batch: [], remaining: 0 });
  });
  it("빈 입력과 잡음 id 의 tried 는 무해", () => {
    expect(selectInferTargets([], tried("x"), { limit: 5 })).toEqual({ batch: [], remaining: 0 });
  });
});

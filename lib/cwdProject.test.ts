import { describe, expect, it } from "vitest";
import { NO_MAPPING_WARNING, pickRouteRule, resolveDraftProject } from "./cwdProject";

const r = (cwdPrefix: string, projectId: string | null, priority = 0) => ({ cwdPrefix, projectId, priority });

describe("pickRouteRule", () => {
  it("경로 세그먼트 단위로 접두사 매칭한다", () => {
    const rules = [r("/a/b", "p1")];
    expect(pickRouteRule(rules, "/a/b")).toBe("p1");
    expect(pickRouteRule(rules, "/a/b/x")).toBe("p1");
    expect(pickRouteRule(rules, "/a/bc")).toBeNull();
    expect(pickRouteRule(rules, "/a")).toBeNull();
  });
  it("가장 긴 접두사가 이긴다", () => {
    const rules = [r("/a", "outer", 9), r("/a/b", "inner", 0)];
    expect(pickRouteRule(rules, "/a/b/c")).toBe("inner");
    expect(pickRouteRule(rules, "/a/z")).toBe("outer");
  });
  it("같은 길이면 priority 가 높은 쪽", () => {
    expect(pickRouteRule([r("/a", "low", 1), r("/a", "high", 5)], "/a/x")).toBe("high");
  });
  it("끝 슬래시는 무시하고, 루트 규칙은 모두 매칭한다", () => {
    expect(pickRouteRule([r("/a/b/", "p")], "/a/b/x")).toBe("p");
    expect(pickRouteRule([r("/", "root")], "/anything")).toBe("root");
  });
  it("projectId 가 null 인 규칙이 이기면 null(매핑 없음)", () => {
    expect(pickRouteRule([r("/a", "p"), r("/a/b", null)], "/a/b")).toBeNull();
  });
  it("규칙 없음 → null", () => {
    expect(pickRouteRule([], "/a")).toBeNull();
  });
});

describe("resolveDraftProject", () => {
  const rules = [r("/work/teamspace", "ts")];
  it("기본(auto)은 cwd 규칙에서 고른다 — 워크트리 경로는 걸리지 않는다", () => {
    expect(resolveDraftProject(undefined, rules, "/work/teamspace")).toEqual({ projectId: "ts" });
    expect(resolveDraftProject("auto", rules, "/work/teamspace-stage4a")).toEqual({ projectId: null, warning: NO_MAPPING_WARNING });
  });
  it("none 은 경고 없이 공용, id 는 그대로", () => {
    expect(resolveDraftProject("none", rules, "/work/teamspace")).toEqual({ projectId: null });
    expect(resolveDraftProject("p9", rules, "/elsewhere")).toEqual({ projectId: "p9" });
  });
});

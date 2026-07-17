import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyHmac, resolveWorkspaceByCwd } from "@/lib/ingest";

const SECRET = "ingest-secret-xyz";
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyHmac", () => {
  const body = '{"sessionId":"s1"}';
  it("유효 서명 → true", () => {
    expect(verifyHmac(SECRET, body, sign(body))).toBe(true);
  });
  it("변조 → false", () => {
    expect(verifyHmac(SECRET, body, sign(body).replace(/.$/, (c) => (c === "a" ? "b" : "a")))).toBe(false);
  });
  it("본문 다르면 → false", () => {
    expect(verifyHmac(SECRET, '{"sessionId":"s2"}', sign(body))).toBe(false);
  });
  it("빈/형식불량 → false", () => {
    expect(verifyHmac(SECRET, body, "")).toBe(false);
    expect(verifyHmac("", body, sign(body))).toBe(false);
  });
});

describe("resolveWorkspaceByCwd", () => {
  const rules = [
    { cwdPrefix: "/Users/a/dev", workspaceId: "ws-dev", priority: 0 },
    { cwdPrefix: "/Users/a/dev/teamspace", workspaceId: "ws-ts", priority: 0 },
    { cwdPrefix: "/Users/a", workspaceId: "ws-home", priority: 5 },
  ];
  it("매칭 중 우선순위 높은 것 우선", () => {
    // priority 5(/Users/a) > priority 0 들
    expect(resolveWorkspaceByCwd("/Users/a/dev/teamspace/app", rules)).toBe("ws-home");
  });
  it("동일 우선순위면 더 긴(구체적) 접두사 우선", () => {
    const r = rules.filter((x) => x.priority === 0);
    expect(resolveWorkspaceByCwd("/Users/a/dev/teamspace/app", r)).toBe("ws-ts");
    expect(resolveWorkspaceByCwd("/Users/a/dev/other", r)).toBe("ws-dev");
  });
  it("매칭 없으면 null", () => {
    expect(resolveWorkspaceByCwd("/tmp/x", rules)).toBeNull();
    expect(resolveWorkspaceByCwd(undefined, rules)).toBeNull();
  });
});

import { resolveRouteByCwd } from "./ingest";

describe("resolveRouteByCwd (프로젝트 스코프 포함)", () => {
  const rules = [
    { cwdPrefix: "/Users/a/dev", workspaceId: "ws1", projectId: null, priority: 0 },
    { cwdPrefix: "/Users/a/dev/teamspace", workspaceId: "ws1", projectId: "p-ts", priority: 0 },
    { cwdPrefix: "/Users/a/dev/dangol", workspaceId: "ws1", projectId: "p-dg", priority: 5 },
  ];
  it("가장 구체적(긴) 접두사의 룰을 통째로 반환한다", () => {
    expect(resolveRouteByCwd("/Users/a/dev/teamspace/lib", rules)).toEqual(rules[1]);
  });
  it("priority 가 길이보다 우선", () => {
    expect(resolveRouteByCwd("/Users/a/dev/dangol/x", rules)?.projectId).toBe("p-dg");
  });
  it("매칭 없으면 null", () => {
    expect(resolveRouteByCwd("/opt/other", rules)).toBeNull();
    expect(resolveRouteByCwd(undefined, rules)).toBeNull();
  });
});

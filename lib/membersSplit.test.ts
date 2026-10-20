import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitMembers, latestTokenByUser } from "./membersSplit";
import { staticImportClosure } from "./moduleImports";

const m = (id: string, email: string) => ({ id, user: { email } });

describe("splitMembers", () => {
  it("사람/에이전트로 나누고 순서를 보존한다", () => {
    const list = Object.freeze([
      m("1", "a@x.com"),
      m("2", "agent-t1@agents.teamspace.local"),
      m("3", "b@x.com"),
      m("4", "agent-t2@agents.teamspace.local"),
    ]);
    const { humans, agents } = splitMembers(list);
    expect(humans.map((x) => x.id)).toEqual(["1", "3"]);
    expect(agents.map((x) => x.id)).toEqual(["2", "4"]);
    expect(list).toHaveLength(4);
  });
  it("pending 에이전트 이메일도 에이전트로 분류한다", () => {
    const { humans, agents } = splitMembers([m("1", "pending-abc@agents.teamspace.local"), m("2", "a@x.com")]);
    expect(agents.map((x) => x.id)).toEqual(["1"]);
    expect(humans.map((x) => x.id)).toEqual(["2"]);
  });
  it("빈 목록", () => {
    expect(splitMembers([])).toEqual({ humans: [], agents: [] });
  });
});

describe("latestTokenByUser", () => {
  it("createdAt 내림차순 입력에서 유저별 첫 행만 고른다", () => {
    const rows = [
      { userId: "u1", id: "t2" },
      { userId: "u1", id: "t1" },
      { userId: "u2", id: "t3" },
    ];
    const map = latestTokenByUser(rows);
    expect(map.get("u1")?.id).toBe("t2");
    expect(map.get("u2")?.id).toBe("t3");
  });
});

describe("membersSplit 는 클라이언트 번들에 node:crypto 를 끌어오지 않는다(감사 P-4)", () => {
  // 지정자는 TS 파서로 뽑고(여러 줄·re-export·타입 전용 구분), 정적 import 를 끝까지 따라간다 — 간접 의존도 잡는다.
  const root = fileURLToPath(new URL("..", import.meta.url));
  const closure = (f: string) => staticImportClosure(fileURLToPath(new URL(`./${f}`, import.meta.url)), root);

  it("membersSplit 은 agentToken(node:crypto) 대신 엣지 안전 agentTokenFormat 을 import", () => {
    const deps = closure("membersSplit.ts");
    expect(deps).toContain("./agentTokenFormat");
    expect([...deps].filter((d) => /(^|\/)agentToken$/.test(d))).toEqual([]);
  });

  it("membersSplit 에서 정적으로 닿는 어디에도 node:crypto 가 없다", () => {
    const deps = closure("membersSplit.ts");
    expect([...deps].filter((d) => d === "node:crypto" || d === "crypto")).toEqual([]);
  });
});

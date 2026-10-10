import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Members, { type MemberItem } from "./Members";

const AGENT_EMAIL_SUFFIX = "@agents.teamspace.local"; // lib/agentToken 의 에이전트 이메일 접미사
const HEAD = "에이전트\u2002·\u2002"; // JSX 의 &ensp; 는 U+2002 로 렌더된다

const human = (id: string, name: string): MemberItem => ({
  id, role: "admin", teamId: null, status: "active", kind: "human",
  user: { id: `u-${id}`, name, email: `${id}@example.com`, image: null },
});
const agent = (id: string, name: string, tok: MemberItem["agentToken"]): MemberItem => ({
  id, role: "editor", teamId: null, status: "active", kind: "agent",
  user: { id: `u-${id}`, name, email: `${id}${AGENT_EMAIL_SUFFIX}`, image: null },
  agentToken: tok,
});

const html = (members: MemberItem[]) =>
  renderToStaticMarkup(<Members initialMembers={members} initialTeams={[]} currentUserId="u-h1" />);

describe("Members — 에이전트 절", () => {
  it("에이전트는 사람 목록과 따로, 토큰 요약·회수 배지·역할과 함께 그린다", () => {
    const out = html([
      human("h1", "사람하나"),
      agent("a1", "빌드봇", { id: "t1", name: "ci", lastUsedAt: "2026-10-01T03:00:00Z", revokedAt: null }),
      agent("a2", "옛봇", { id: "t2", name: "old", lastUsedAt: null, revokedAt: "2026-09-01T00:00:00Z" }),
      agent("a3", "토큰없음봇", null),
    ]);
    const agentPart = out.slice(out.indexOf(HEAD));
    expect(out).toContain(`${HEAD}3`);
    expect(agentPart).toContain("빌드봇");
    expect(agentPart).toContain("ci · 마지막 사용 10월 1일");
    expect(agentPart).toContain("old · 마지막 사용 없음");
    expect(agentPart).toContain("토큰 정보 없음");
    expect(agentPart.match(/회수됨/g)).toHaveLength(1);
    expect(agentPart).toContain("편집자");
    expect(agentPart).not.toContain("사람하나");
    // 사람 목록 쪽에는 에이전트가 없다
    expect(out.slice(0, out.indexOf(HEAD))).not.toContain("빌드봇");
  });

  it("관리 링크는 설정의 에이전트 토큰 절로 바로 간다", () => {
    expect(html([human("h1", "사람하나")])).toContain('href="/settings#agent-tokens"');
  });

  it("에이전트가 없으면 빈 안내를 보여준다", () => {
    const out = html([human("h1", "사람하나")]);
    expect(out).toContain(`${HEAD}0`);
    expect(out).toContain("에이전트 토큰이 없어요.");
  });
});

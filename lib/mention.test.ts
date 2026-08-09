import { describe, expect, it } from "vitest";
import { parseMentions } from "./mention";

const NAMES = ["이호준", "mac-mini-claude", "테스트 (Claude QA)", "legacy-cli"];

describe("parseMentions", () => {
  it("@이름 을 멤버 이름과 매칭한다 (긴 이름 우선)", () => {
    expect(parseMentions("@이호준 확인해줘", NAMES)).toEqual(["이호준"]);
    expect(parseMentions("@mac-mini-claude 가 처리", NAMES)).toEqual(["mac-mini-claude"]);
  });
  it("공백 포함 이름도 매칭한다", () => {
    expect(parseMentions("@테스트 (Claude QA) 봐줘", NAMES)).toEqual(["테스트 (Claude QA)"]);
  });
  it("여러 멘션·중복 제거", () => {
    expect(parseMentions("@이호준 @legacy-cli @이호준", NAMES)).toEqual(["이호준", "legacy-cli"]);
  });
  it("매칭 안 되는 @텍스트는 무시", () => {
    expect(parseMentions("@없는사람 hi", NAMES)).toEqual([]);
    expect(parseMentions("email@example.com", NAMES)).toEqual([]);
  });
  it("빈 본문/이름 목록 방어", () => {
    expect(parseMentions("", NAMES)).toEqual([]);
    expect(parseMentions("@이호준", [])).toEqual([]);
  });
});

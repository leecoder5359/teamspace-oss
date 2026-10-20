import { describe, it, expect } from "vitest";
import { internalDomains, matchesType, memoryDirFor, parseMemoryFile, parseSelection, scanSecrets, toLesson } from "./memoryImport";

const FB = `---
name: feedback-reply-in-korean
description: 답변은 한국어로
metadata:
  node_type: memory
  type: feedback
  originSessionId: x
---

사용자에게 보이는 답변은 **항상 한국어**로.
`;

describe("parseMemoryFile", () => {
  it("최상위 name·description, metadata 아래 들여쓴 type 을 읽고 본문을 다듬는다", () => {
    expect(parseMemoryFile(FB, "feedback-reply-in-korean.md")).toEqual({
      file: "feedback-reply-in-korean.md",
      name: "feedback-reply-in-korean",
      description: "답변은 한국어로",
      type: "feedback",
      body: "사용자에게 보이는 답변은 **항상 한국어**로.",
    });
  });
  it("최상위 type 도 받고 따옴표를 벗긴다, CRLF 도 읽는다", () => {
    const e = parseMemoryFile(`---\r\nname: "a"\r\ntype: 'feedback'\r\n---\r\nb`, "a.md");
    expect(e).toMatchObject({ name: "a", type: "feedback", body: "b" });
  });
  it("큰따옴표 값의 \\\" 이스케이프를 푼다(작은따옴표는 '' → ')", () => {
    const e = parseMemoryFile(`---\nname: a\ndescription: "다른 \\"기본값\\" 금지 \\\\ 끝"\ntype: 'it''s'\n---\nb`, "a.md");
    expect(e).toMatchObject({ description: '다른 "기본값" 금지 \\ 끝', type: "it's" });
  });
  it("한국어 name·description 을 그대로 읽는다", () => {
    const e = parseMemoryFile(`---\nname: 답변-한국어\ndescription: 설명은 한국어로: 항상\n---\n본문`, "x.md");
    expect(e).toMatchObject({ name: "답변-한국어", description: "설명은 한국어로: 항상" });
  });
  it("빈 name 은 빈 문자열, type 이 없으면 null(파일명으로 채우지 않는다)", () => {
    const e = parseMemoryFile(`---\nname: ""\nmetadata: \n  node_type: memory\n---\n첫 줄`, "feedback-x.md");
    expect(e).toMatchObject({ name: "", description: "", type: null, body: "첫 줄" });
  });
  it("frontmatter 가 없거나 닫히지 않으면 null(MEMORY.md 같은 색인)", () => {
    expect(parseMemoryFile("# 인덱스\n- a", "MEMORY.md")).toBeNull();
    expect(parseMemoryFile("---\nname: a\n본문", "a.md")).toBeNull();
  });
});

describe("matchesType", () => {
  it("지정 type 만, any 는 전부(type 없음 포함)", () => {
    expect(matchesType({ type: "feedback" }, "feedback")).toBe(true);
    expect(matchesType({ type: "project" }, "feedback")).toBe(false);
    expect(matchesType({ type: null }, "feedback")).toBe(false);
    expect(matchesType({ type: null }, "any")).toBe(true);
  });
});

describe("toLesson", () => {
  const base = { file: "a.md", name: "a", description: "제목", type: "feedback", body: "본문" };
  it("제목=description, 본문=파일 본문", () => {
    expect(toLesson(base)).toEqual({ ok: true, title: "제목", body: "본문" });
  });
  it("name·description·본문 중 빠진 것을 알려 준다", () => {
    expect(toLesson({ ...base, name: "", description: " " })).toEqual({ ok: false, missing: ["name", "description"] });
    expect(toLesson({ ...base, body: "  " })).toEqual({ ok: false, missing: ["body"] });
  });
});

describe("memoryDirFor", () => {
  it("Claude Code 의 프로젝트 폴더 규칙(영숫자 외 → -)", () => {
    expect(memoryDirFor("/Users/ljun/dev/ljun/teamspace", "/Users/ljun")).toBe("/Users/ljun/.claude/projects/-Users-ljun-dev-ljun-teamspace/memory");
    expect(memoryDirFor("/h/a.b_c", "/h")).toBe("/h/.claude/projects/-h-a-b-c/memory");
  });
});

describe("internalDomains", () => {
  it("URL 의 호스트를 상위 도메인으로(3단 이상이면 첫 칸 뺌), localhost·IP·빈 값 제외", () => {
    expect(
      internalDomains(["https://ts.internal.co.kr/x", "http://localhost:3002", "http://127.0.0.1:3000", undefined, "", "https://mac.tail1.ts.net", "a.example.com, b.org"]),
    ).toEqual(["internal.co.kr", "tail1.ts.net", "example.com", "b.org"]);
  });
});

describe("scanSecrets", () => {
  it("토큰·이메일·내부 주소가 있는 줄을 종류와 줄 번호로", () => {
    const hits = scanSecrets(
      [
        "토큰 wst_abcdef0123456789 를 넣는다",
        "키 sk-ant-api03-xxxx",
        "슬랙 xoxb-123-456",
        "계정 e2e-owner@loyo.test",
        "주소 https://mac-mini.tailabc.ts.net 접속",
        "맥미니 100.101.102.103",
        "공개 링크 https://ts.internal.co.kr/pages/a",
        "평범한 줄 localhost:3002 · 192.168.0.1 같은 흔한 예시",
      ].join("\n"),
      ["internal.co.kr"],
    );
    expect(hits.map((h) => [h.line, h.kind])).toEqual([
      [1, "token"],
      [2, "token"],
      [3, "token"],
      [4, "email"],
      [5, "host"],
      [6, "host"],
      [7, "host"],
    ]);
  });
  it("비슷하지만 아닌 것은 잡지 않는다", () => {
    const text = [
      "task-1 은 sk 접두사가 없다",
      "risk-free 한 변경",
      "pnpm ws 명령, localhost:3002",
      "버전 100.5 와 IP 100.200.1.1(테일스케일 대역 밖)",
      "@이름 멘션",
      "wst_ 접두사만 언급",
    ].join("\n");
    expect(scanSecrets(text, ["internal.co.kr"])).toEqual([]);
  });
  it("발췌는 값을 가린다", () => {
    expect(scanSecrets("wst_abcdef0123456789")[0].excerpt).not.toContain("abcdef0123456789");
    const ex = scanSecrets("계정 owner@shop.test / admin@shop.test")[0].excerpt;
    expect(ex).not.toContain("owner@shop.test");
    expect(ex).not.toContain("admin@shop.test");
  });
});

describe("parseSelection", () => {
  it("1,3,5-7 · a/all · 빈칸=[] · 범위 밖·잘못된 입력은 null", () => {
    expect(parseSelection("1,3,5-7", 8)).toEqual([1, 3, 5, 6, 7]);
    expect(parseSelection(" 3, 1 ,3 ", 3)).toEqual([1, 3]);
    expect(parseSelection("a", 3)).toEqual([1, 2, 3]);
    expect(parseSelection("ALL", 2)).toEqual([1, 2]);
    expect(parseSelection("", 3)).toEqual([]);
    expect(parseSelection("4", 3)).toBeNull();
    expect(parseSelection("0", 3)).toBeNull();
    expect(parseSelection("x", 3)).toBeNull();
    expect(parseSelection("3-1", 3)).toBeNull();
  });
});

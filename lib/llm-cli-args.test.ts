import { describe, expect, it } from "vitest";
import { claudeCliArgs } from "@/lib/llm";

// 키 없는 대체 경로(claude -p)는 합성 텍스트만 만들어야 한다 — 워크스페이스 문서·질문이 프롬프트로
// 들어가므로, 도구·사용자 설정(bypassPermissions)·훅·MCP 가 살아 있으면 인젝션이 서버 권한 도구 실행이 된다.
describe("claudeCliArgs — 격리된 텍스트 전용 호출", () => {
  const args = claudeCliArgs("질문", "claude-haiku-4-5");

  it("도구를 전부 끈다(--tools 빈 값) — allowedTools 는 bypass 모드에서 제한이 아니다", () => {
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("");
    expect(args).not.toContain("--allowedTools");
  });

  it("사용자·프로젝트 설정, MCP, 세션 저장을 읽지 않고 권한 모드를 dontAsk(미리 허용 안 된 동작은 거부)로 고정한다", () => {
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(at("--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(at("--permission-mode")).toBe("dontAsk");
  });

  it("OAuth 를 읽지 못하는 --bare 는 쓰지 않는다(키 없는 대체라는 목적)", () => {
    expect(args).not.toContain("--bare");
  });

  it("프롬프트는 -p 의 값으로만 들어간다", () => {
    expect(args[args.indexOf("-p") + 1]).toBe("질문");
  });
});

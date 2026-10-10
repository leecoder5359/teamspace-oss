import { describe, expect, it } from "vitest";
import { claudeCliArgs, parseClaudeCliOutput } from "@/lib/llm";

// `claude -p --output-format json` 결과 → 텍스트·토큰(LlmCall 의 cli 행에 토큰을 남기기 위해).
const ok = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1234,
  num_turns: 1,
  result: "  안녕하세요  ",
  session_id: "s",
  total_cost_usd: 0.0012,
  usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 7 },
});

describe("claudeCliArgs — 출력 형식", () => {
  it("json 으로 받는다(토큰 수 확보)", () => {
    const args = claudeCliArgs("q", "m");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });
});

describe("parseClaudeCliOutput", () => {
  it("성공: result 텍스트(trim) + 입력 토큰은 캐시 생성·읽기 포함, 출력 토큰", () => {
    expect(parseClaudeCliOutput(ok)).toEqual({ text: "안녕하세요", errorKind: null, inputTokens: 3210, outputTokens: 7 });
  });

  it("usage 가 없으면 토큰 null", () => {
    expect(parseClaudeCliOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "x" }))).toEqual({
      text: "x", errorKind: null, inputTokens: null, outputTokens: null,
    });
  });

  it("is_error / subtype 오류 → 실패, errorKind = subtype(토큰은 남긴다)", () => {
    const r = parseClaudeCliOutput(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, usage: { input_tokens: 5, output_tokens: 1 } }));
    expect(r).toEqual({ text: null, errorKind: "error_max_turns", inputTokens: 5, outputTokens: 1 });
    expect(parseClaudeCliOutput(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Credit balance is too low" }))).toMatchObject({
      text: null, errorKind: "is_error",
    });
  });

  it("빈 결과 → empty", () => {
    expect(parseClaudeCliOutput(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "  " }))).toMatchObject({ text: null, errorKind: "empty" });
    expect(parseClaudeCliOutput("")).toMatchObject({ text: null, errorKind: "empty" });
  });

  it("JSON 이 아니면 평문 텍스트(종전 동작) + 토큰 null", () => {
    expect(parseClaudeCliOutput("그냥 텍스트\n")).toEqual({ text: "그냥 텍스트", errorKind: null, inputTokens: null, outputTokens: null });
  });

  it("결과 객체가 아닌 JSON 은 평문으로", () => {
    expect(parseClaudeCliOutput('{"answer":1}')).toEqual({ text: '{"answer":1}', errorKind: null, inputTokens: null, outputTokens: null });
  });

  it("이벤트 배열이면 마지막 result 를 쓴다", () => {
    const arr = JSON.stringify([{ type: "system" }, JSON.parse(ok)]);
    expect(parseClaudeCliOutput(arr)).toMatchObject({ text: "안녕하세요", inputTokens: 3210, outputTokens: 7 });
  });
});

import { describe, expect, it } from "vitest";
import { maxTokensFor, modelFor, tierOf } from "@/lib/llmPolicy";

// Next 가 ProcessEnv 에 NODE_ENV 를 필수로 넣어 둬서 테스트용 env 리터럴은 캐스트한다.
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("tierOf — 기능 → 모델 등급", () => {
  it("ask 만 합성, 나머지·미지정은 추출", () => {
    expect(tierOf("ask")).toBe("synthesize");
    for (const f of ["clip", "graph-infer", "qa-extract", "dod-extract", "provenance", "feedback-classify", "search-concept", "complete", undefined, ""]) {
      expect(tierOf(f)).toBe("extract");
    }
  });
});

describe("maxTokensFor — 기능별 출력 상한", () => {
  it("표에 있는 기능", () => {
    expect(maxTokensFor("ask")).toBe(700);
    expect(maxTokensFor("feedback-classify")).toBe(600);
    expect(maxTokensFor("search-concept")).toBe(300);
    expect(maxTokensFor("graph-infer")).toBe(800);
    expect(maxTokensFor("provenance")).toBe(500);
    expect(maxTokensFor("clip")).toBe(800);
  });
  it("*-extract 와 기본값은 1500", () => {
    for (const f of ["qa-extract", "dod-extract", "entities-extract", "glossary-extract", "onboarding-extract", "complete", "whatever", undefined]) {
      expect(maxTokensFor(f)).toBe(1500);
    }
  });
});

describe("modelFor — env 우선순위", () => {
  it("api 기본값: 합성 sonnet · 추출 haiku", () => {
    expect(modelFor("api", "synthesize", env({}))).toBe("claude-sonnet-4-6");
    expect(modelFor("api", "extract", env({}))).toBe("claude-haiku-4-5");
  });
  it("api: ANTHROPIC_MODEL 은 합성만, ANTHROPIC_MODEL_EXTRACT 는 추출만", () => {
    const both = env({ ANTHROPIC_MODEL: " s-model ", ANTHROPIC_MODEL_EXTRACT: "e-model" });
    expect(modelFor("api", "synthesize", both)).toBe("s-model");
    expect(modelFor("api", "extract", both)).toBe("e-model");
    expect(modelFor("api", "extract", env({ ANTHROPIC_MODEL: "s-model" }))).toBe("claude-haiku-4-5");
  });
  it("cli 기본값은 둘 다 haiku", () => {
    expect(modelFor("cli", "synthesize", env({}))).toBe("claude-haiku-4-5");
    expect(modelFor("cli", "extract", env({}))).toBe("claude-haiku-4-5");
  });
  it("cli: 추출은 ASK_CLAUDE_MODEL_EXTRACT → ASK_CLAUDE_MODEL → 기본", () => {
    expect(modelFor("cli", "extract", env({ ASK_CLAUDE_MODEL: "c" }))).toBe("c");
    expect(modelFor("cli", "extract", env({ ASK_CLAUDE_MODEL: "c", ASK_CLAUDE_MODEL_EXTRACT: "ce" }))).toBe("ce");
    expect(modelFor("cli", "synthesize", env({ ASK_CLAUDE_MODEL: "c", ASK_CLAUDE_MODEL_EXTRACT: "ce" }))).toBe("c");
  });
  it("빈 문자열·공백 env 는 없는 것으로 본다", () => {
    expect(modelFor("api", "extract", env({ ANTHROPIC_MODEL_EXTRACT: "  " }))).toBe("claude-haiku-4-5");
    expect(modelFor("cli", "extract", env({ ASK_CLAUDE_MODEL_EXTRACT: "", ASK_CLAUDE_MODEL: " " }))).toBe("claude-haiku-4-5");
  });
});

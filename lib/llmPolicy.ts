/* =====================================================================
   LLM 호출 정책(순수) — 기능(feature) 태그 → 모델 등급·출력 상한(A-5).

   - 합성(synthesize): 사람이 읽는 답을 쓰는 호출(ask). 품질 우선.
   - 추출(extract): 구조화 추출·분류·짧은 판정. 싼 모델로 충분하다.
   env 로 등급별 모델을 바꿀 수 있다(값은 비밀 아님 — 화면에도 보인다).
   ===================================================================== */

export type LlmTier = "synthesize" | "extract";

const SYNTHESIZE_FEATURES = new Set(["ask"]);

/** "ask" 만 합성, 그 외(미지정 포함)는 전부 추출. */
export function tierOf(feature: string | undefined): LlmTier {
  return feature && SYNTHESIZE_FEATURES.has(feature) ? "synthesize" : "extract";
}

const MAX_TOKENS: Record<string, number> = {
  ask: 700,
  "feedback-classify": 600, // 한국어 title/summary/reason 5필드 JSON — 200 이면 잘려 파싱 실패
  "search-concept": 300,
  "graph-infer": 800, // 최대 3×{id(cuid),reason} — 300 이면 잘려 [] → inferTriedAt 이 영구로 찍힌다
  provenance: 500,
  clip: 800,
};
const DEFAULT_MAX_TOKENS = 1500; // *-extract 와 미지정

/** 기능별 max_tokens(api 경로). 표에 없으면 1500. */
export function maxTokensFor(feature: string | undefined): number {
  return (feature && MAX_TOKENS[feature]) || DEFAULT_MAX_TOKENS;
}

const pick = (...vals: (string | undefined)[]): string | undefined => {
  for (const v of vals) {
    const t = (v ?? "").trim();
    if (t) return t;
  }
  return undefined;
};

/**
 * 프로바이더·등급 → 모델 이름.
 *   api: 합성 ANTHROPIC_MODEL || sonnet · 추출 ANTHROPIC_MODEL_EXTRACT || haiku
 *   cli: 합성 ASK_CLAUDE_MODEL || haiku · 추출 ASK_CLAUDE_MODEL_EXTRACT || ASK_CLAUDE_MODEL || haiku
 */
export function modelFor(provider: "api" | "cli", tier: LlmTier, env: NodeJS.ProcessEnv): string {
  if (provider === "api") {
    return tier === "synthesize"
      ? pick(env.ANTHROPIC_MODEL) ?? "claude-sonnet-4-6"
      : pick(env.ANTHROPIC_MODEL_EXTRACT) ?? "claude-haiku-4-5";
  }
  return tier === "synthesize"
    ? pick(env.ASK_CLAUDE_MODEL) ?? "claude-haiku-4-5"
    : pick(env.ASK_CLAUDE_MODEL_EXTRACT, env.ASK_CLAUDE_MODEL) ?? "claude-haiku-4-5";
}

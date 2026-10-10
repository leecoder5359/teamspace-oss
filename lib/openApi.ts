/* AUTH_OPEN_API 데모 스위치 판정 — 순수 함수 모듈(엣지 미들웨어에서도 import 된다: Node 전용 import 금지).
 * production 빌드에서는 값과 무관하게 꺼진다 — 상시 배포에서 실수로 켜져도 뒷문이 열리지 않게.
 *
 * 기본값은 **정적 참조**(`process.env.AUTH_OPEN_API`·`process.env.NODE_ENV`)여야 한다.
 * Next 는 리터럴 `process.env.X` 만 번들에 인라인한다 — 특히 `process.env.NODE_ENV` 는
 * `next build` 때 "production" 으로 박히므로 production 번들은 런타임 env 와 무관하게 절대 열리지 않는다.
 * `env = process.env` 로 통째 받으면 정적 변수만 주입하는 엣지 호스트(Vercel 등)에서 값이 비고,
 * NODE_ENV 가 비면 "!== production" 이 참이 되어 열리는(fail-open) 경로가 생긴다.
 * 테스트는 인자로 값을 주입한다. */

export function openApiEnabled(
  open: string | undefined = process.env.AUTH_OPEN_API,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  return open === "true" && nodeEnv !== "production";
}

export function openApiStartupWarning(
  open: string | undefined = process.env.AUTH_OPEN_API,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | null {
  if (open !== "true") return null;
  if (nodeEnv === "production") {
    return "AUTH_OPEN_API=true 는 production 에서 무시됩니다(데모/로컬 전용 스위치). 에이전트 토큰(wst_)이나 로그인 세션을 사용하세요.";
  }
  return "⚠️ AUTH_OPEN_API=true — 토큰 없이 누구나 admin 으로 /api 에 접근할 수 있습니다. 로컬 데모 전용이며 공개 서버에서는 켜지 마세요.";
}

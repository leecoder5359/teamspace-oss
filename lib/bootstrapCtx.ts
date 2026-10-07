/* AUTH_OPEN_API=true 부트스트랩 ctx 판별 — lib/workspace 에서 떼어 낸 순수 조각.
   (라우트·테스트가 lib/workspace 전체를 끌어오지 않고 쓸 수 있게.) */

/** resolveLegacyCtx 가 만드는 시스템 actor 이름. */
export const LEGACY_ACTOR_NAME = "legacy-cli";

/**
 * 세션·에이전트 토큰 **없이** `AUTH_OPEN_API=true` 하나로 발급된 admin ctx 인가.
 *
 * 그 플래그가 켜진 서버에서는 아무나 admin 이므로, 자격 증명을 다루는 라우트(인테이크)는
 * 이 ctx 위에서 열지 않는다. 진짜 로그인 세션·에이전트 토큰 경로는 여기 걸리지 않으므로
 * 로컬 개발이 막히지 않는다(로그인하면 그대로 쓸 수 있다).
 */
export function isBootstrapCtx(ctx: { actor: { type: "user" | "agent"; name: string } }): boolean {
  return ctx.actor.type === "agent" && ctx.actor.name === LEGACY_ACTOR_NAME;
}

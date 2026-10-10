/* 요청의 '사람' — 개인 레슨(Lesson.userId)의 기준.
   사람 세션이면 본인, 에이전트 토큰이면 그 토큰을 발급한 사람(AgentToken.issuedById), 알 수 없으면 null.
   순수 함수(lib/workspace 를 mock 하는 라우트 테스트에서도 그대로 쓰이도록 따로 둔다). */

export type ViewerCtxLike = {
  userId: string;
  actor?: { type: "user" | "agent" } | null;
  /** lib/workspace 가 채운다: 사람 = userId, 에이전트 토큰 = issuedById(없으면 null), 부트스트랩 = null */
  personId?: string | null;
};

export function viewerPersonId(ctx: ViewerCtxLike): string | null {
  if (ctx.personId !== undefined) return ctx.personId;
  // personId 를 모르는 Ctx(구 호출부·테스트 mock): 에이전트면 사람을 모른다, 아니면 본인.
  if (ctx.actor?.type === "agent") return null;
  return ctx.userId;
}

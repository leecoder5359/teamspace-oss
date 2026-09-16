import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

/**
 * 엣지 안전(edge-safe) Auth.js 설정.
 * Prisma 어댑터(노드 전용)는 여기 두지 않고 auth.ts에서 합성한다.
 * 미들웨어(엣지 런타임)는 이 설정만 import 한다.
 *
 * Google()는 v5에서 환경변수 AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET 를 자동으로 읽는다.
 */
export const authConfig = {
  // 초대는 User 행을 로그인 전에 만든다 → 첫 Google 로그인이 그 행에 연결돼야 한다(기본값은
  // OAuthAccountNotLinked 로 거부). 안전 조건(email_verified)은 auth.ts signIn 콜백이 강제한다.
  providers: [Google({ allowDangerousEmailAccountLinking: true })],
  pages: {
    signIn: "/login",
    // 접근 거부(초대/허용 도메인 아님) 등 오류도 우리 로그인 화면으로
    error: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    // 로그인 시 사용자 id를 토큰에 적재
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    // 세션에 사용자 id 노출
    session({ session, token }) {
      if (session.user) {
        session.user.id =
          (token.id as string | undefined) ?? token.sub ?? session.user.id;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;

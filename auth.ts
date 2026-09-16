import NextAuth from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/auth.config";
import { isSignInAllowed, isVerifiedOAuthEmail } from "@/lib/accessControl";

/**
 * 노드 런타임용 Auth.js 인스턴스.
 * 엣지 안전 설정(authConfig)에 Prisma 어댑터 + 접근제어 signIn 콜백을 합성한다.
 * 커스텀 출력 경로의 생성된 Prisma 클라이언트라 어댑터 시그니처에 맞춰 캐스팅한다.
 *
 * signIn 게이트(prisma 필요 → 노드 전용)는 미들웨어(엣지)가 아닌 여기에서만 동작한다.
 * 초대(멤버십) 또는 허용 도메인이 아닌 계정은 로그인이 거부된다. → /login?error=AccessDenied
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(
    prisma as unknown as Parameters<typeof PrismaAdapter>[0],
  ),
  callbacks: {
    ...authConfig.callbacks,
    async signIn({ user, account, profile }) {
      // 계정 자동 연결(auth.config.ts)의 전제 — Google 이 확인하지 않은 이메일은 받지 않는다.
      if (!isVerifiedOAuthEmail(account?.provider, profile)) return false;
      return isSignInAllowed(user?.email);
    },
  },
});

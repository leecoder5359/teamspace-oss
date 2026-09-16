import AppShell from "@/components/AppShell";
import { auth } from "@/auth";
import { getPageContext } from "@/lib/workspace";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  // 멤버십 게이트를 레이아웃에서 한 번 건다. 페이지마다 getPageContext 를 부르는 곳도 있고 안 부르는 곳도
  // 있어서, 멤버가 아닌 로그인 사용자(퍼블리시 게스트)가 클라이언트 페이지에 들어오면 빈 껍데기가 떴다.
  // 비멤버는 /login?error=AccessDenied 로 간다(데이터는 원래 API 의 requireCtx 가 막는다).
  await getPageContext();

  // 세션이 있으면 사용자 카드를 세션 사용자로 표시한다.
  // 세션이 없으면(자격증명 미설정/미로그인) null → 시드 사용자 폴백.
  const session = await auth();
  const sessionUser = session?.user
    ? {
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      }
    : null;

  return <AppShell sessionUser={sessionUser}>{children}</AppShell>;
}

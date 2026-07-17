import AppShell from "@/components/AppShell";
import { auth } from "@/auth";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
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

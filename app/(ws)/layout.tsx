import AppShell from "@/components/AppShell";
import { auth } from "@/auth";
import { getPageContext } from "@/lib/workspace";
import { loadAccess } from "@/lib/pageGuard";
import { listPagesForSidebar, listProjectsForSidebar } from "@/lib/pagesList";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  // 멤버십 게이트를 레이아웃에서 한 번 건다. 페이지마다 getPageContext 를 부르는 곳도 있고 안 부르는 곳도
  // 있어서, 멤버가 아닌 로그인 사용자(퍼블리시 게스트)가 클라이언트 페이지에 들어오면 빈 껍데기가 떴다.
  // 비멤버는 /login?error=AccessDenied 로 간다(데이터는 원래 API 의 requireCtx 가 막는다).
  const ctx = await getPageContext();

  // U7: 첫 페인트에 사이드바 트리가 비지 않게 서버에서 같이 읽어 넘긴다(클라는 마운트 때 /api/pages 를 건너뛴다).
  // 실패해도 레이아웃은 깨지면 안 된다 — null 이면 사이드바가 예전처럼 클라에서 받는다.
  // 접근 인덱스는 한 번만 만들어 두 목록이 공유한다(전체 스캔 2회 → 1회).
  // 목록을 읽기 시작한 시각 — 클라 캐시는 이 시각부터 TTL 을 센다(받은 시각으로 찍으면 하이드레이션 시간만큼 더 산다).
  const serverTime = new Date().toISOString();
  const [pages, projects] = await loadAccess(ctx)
    .then((access) => Promise.all([listPagesForSidebar(ctx, access), listProjectsForSidebar(ctx, access)]))
    .catch(() => [null, null] as const);
  const initialSidebar = pages && projects ? { pages, projects, serverTime } : null;

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

  return <AppShell sessionUser={sessionUser} initialSidebar={initialSidebar}>{children}</AppShell>;
}

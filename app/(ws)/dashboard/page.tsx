import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";
import Dashboard from "@/components/ws/Dashboard";

// 인사말의 사용자 이름만 서버(lib/workspace 컨텍스트)에서 해석하고,
// 실제 태스크 현황 데이터는 Dashboard(클라이언트)가 DatabaseView처럼 fetch 한다.
export default async function DashboardPage() {
  let userName = "회원";
  try {
    const { userId } = await getPageContext();
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    if (user?.name) userName = user.name;
  } catch {
    // 컨텍스트 해석 실패 시 기본값으로 폴백 (비파괴적)
  }
  return <Dashboard userName={userName} />;
}

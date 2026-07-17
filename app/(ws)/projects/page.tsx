import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";
import { getProjectsWithStats } from "@/lib/projects";
import Projects from "@/components/ws/Projects";

// 서버 컴포넌트: 프로젝트 카드 지표 + 리드 선택용 멤버 목록을 페치해 클라이언트에 전달.
export default async function ProjectsPage() {
  const { workspaceId } = await getPageContext();

  const [initialProjects, memberRows] = await Promise.all([
    getProjectsWithStats(workspaceId),
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const members = memberRows.map((m) => ({
    id: m.user.id,
    name: m.user.name ?? m.user.email,
  }));

  return <Projects initialProjects={initialProjects} members={members} />;
}

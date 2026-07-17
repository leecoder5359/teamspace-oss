import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";
import Members from "@/components/ws/Members";
import type { MemberItem, TeamItem } from "@/components/ws/Members";

// 서버 컴포넌트: 현재 워크스페이스 멤버·팀을 Prisma로 페치한 뒤 클라이언트 컴포넌트에 전달.
export default async function MembersPage() {
  const { workspaceId, userId } = await getPageContext();

  const [raw, teams] = await Promise.all([
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.team.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { members: true } } },
    }),
  ]);

  // Date 필드를 제거하고 직렬화 가능한 타입으로 매핑
  const initialMembers: MemberItem[] = raw.map((m) => ({
    id: m.id,
    role: m.role,
    teamId: m.teamId,
    status: m.status,
    user: { id: m.user.id, name: m.user.name, email: m.user.email, image: m.user.image },
  }));
  const initialTeams: TeamItem[] = teams.map((t) => ({ id: t.id, name: t.name, color: t.color, memberCount: t._count.members }));

  return <Members initialMembers={initialMembers} initialTeams={initialTeams} currentUserId={userId} />;
}

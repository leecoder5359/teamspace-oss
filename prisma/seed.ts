import "dotenv/config";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pageFilePath, writeContent } from "../lib/content";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  // 단일 내부 사용자 + 워크스페이스 부트스트랩 (멱등)
  const user = await prisma.user.upsert({
    where: { email: "you@example.com" },
    update: {},
    create: { email: "you@example.com", name: "이호준" },
  });

  let workspace = await prisma.workspace.findFirst({ where: { name: "TeamSpace" } });
  if (!workspace) {
    workspace = await prisma.workspace.create({ data: { name: "TeamSpace" } });
  }

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    update: {},
    create: { workspaceId: workspace.id, userId: user.id, role: "admin" },
  });

  // 샘플 멤버 (이미 있으면 스킵) — 멤버 관리 화면 데모용
  const sampleMembers = [
    { email: "kimdev@example.com", name: "김개발", role: "editor" as const },
    { email: "parkdesign@example.com", name: "박디자인", role: "editor" as const },
    { email: "leeviewer@example.com", name: "이뷰어", role: "viewer" as const },
  ];
  for (const m of sampleMembers) {
    const sampleUser = await prisma.user.upsert({
      where: { email: m.email },
      update: {},
      create: { email: m.email, name: m.name },
    });
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: sampleUser.id } },
      update: {},
      create: { workspaceId: workspace.id, userId: sampleUser.id, role: m.role },
    });
  }

  // 샘플 페이지 (이미 있으면 스킵)
  const existing = await prisma.page.count({ where: { workspaceId: workspace.id } });
  if (existing === 0) {
    const samples = [
      { title: "환영합니다 👋", md: "# 환영합니다\n\nTeamSpace 첫 페이지입니다. 자유롭게 편집해보세요.\n" },
      { title: "회의록", md: "# 회의록\n\n- 안건 1\n- 안건 2\n" },
      { title: "할 일", md: "# 할 일\n\n- [ ] 첫 번째 태스크\n- [ ] 두 번째 태스크\n" },
    ];
    let pos = 0;
    for (const s of samples) {
      const page = await prisma.page.create({
        data: {
          workspaceId: workspace.id,
          title: s.title,
          position: pos++,
          createdById: user.id,
          markdown: s.md,
        },
      });
      const filePath = pageFilePath(workspace.id, page.id);
      await writeContent(filePath, s.md, `seed: ${s.title}`);
      await prisma.page.update({ where: { id: page.id }, data: { filePath } });
    }
  }

  // 샘플 프로젝트 (없을 때만 생성) — projects 화면 데모용
  const memberUsers = await prisma.user.findMany({
    where: { memberships: { some: { workspaceId: workspace.id } } },
    select: { id: true, email: true },
  });
  const leadId = (email: string) => memberUsers.find((u) => u.email === email)?.id ?? user.id;

  if ((await prisma.project.count({ where: { workspaceId: workspace.id } })) === 0) {
    const sampleProjects = [
      { name: "iOS 앱", short: "iOS", color: "blue", description: "리코더 iOS 클라이언트 QA·버그 트래킹", lead: "you@example.com" },
      { name: "AOS 앱", short: "AOS", color: "green", description: "리코더 Android 클라이언트 QA·버그 트래킹", lead: "kimdev@example.com" },
      { name: "코어 백엔드", short: "CORE", color: "purple", description: "STT 파이프라인·API 서버", lead: "kimdev@example.com" },
      { name: "웹", short: "WEB", color: "orange", description: "랜딩·대시보드 웹", lead: "parkdesign@example.com" },
    ];
    let ppos = 0;
    for (const sp of sampleProjects) {
      await prisma.project.create({
        data: {
          workspaceId: workspace.id,
          name: sp.name,
          short: sp.short,
          color: sp.color,
          description: sp.description,
          leadId: leadId(sp.lead),
          position: ppos++,
        },
      });
    }
  }

  // CrewPool 프로젝트 (코드 repo 링크) — 없을 때만 생성. 다제품 허브 dogfooding.
  if (!(await prisma.project.findFirst({ where: { workspaceId: workspace.id, name: "CrewPool" } }))) {
    const lastPos = await prisma.project.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        name: "CrewPool",
        short: "CREW",
        color: "green",
        description: "다매장 운영자용 직원 공유 풀 기반 근무·급여 관리 SaaS",
        repoUrl: "https://github.com/leecoder5359/crewpool",
        repoPath: "/Users/ljun/dev/crewpool",
        repoBranch: "main",
        docsDir: "crewpool",
        leadId: user.id,
        position: (lastPos?.position ?? -1) + 1,
      },
    });
  }

  // 미연결 페이지를 프로젝트에 분배 (database 페이지 우선 → 카드마다 실지표가 보이도록)
  const projects = await prisma.project.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { position: "asc" },
    select: { id: true },
  });
  if (projects.length > 0) {
    const unlinked = await prisma.page.findMany({
      where: { workspaceId: workspace.id, projectId: null, deletedAt: null },
      orderBy: [{ kind: "desc" }, { position: "asc" }], // database 먼저
      select: { id: true },
    });
    for (let i = 0; i < unlinked.length; i++) {
      await prisma.page.update({
        where: { id: unlinked[i].id },
        data: { projectId: projects[i % projects.length].id },
      });
    }
  }

  console.log(`Seed done. workspace=${workspace.id} user=${user.id} projects=${projects.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

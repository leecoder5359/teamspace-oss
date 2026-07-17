import { prisma } from "@/lib/prisma";

export type SelectOption = { id: string; name: string; color: string };

function opt(name: string, color: string): SelectOption {
  return { id: crypto.randomUUID(), name, color };
}

/**
 * "태스크 보드" 템플릿: 미리 정의된 속성/뷰/샘플행을 가진 database 페이지 생성.
 * 태스크(T1/T2)는 별도 테이블 없이 DbRow를 재사용한다. (PLAN §3)
 */
export async function createTaskDatabase(
  workspaceId: string,
  userId: string,
  title: string,
  parentId: string | null,
  projectId: string | null = null,
) {
  const last = await prisma.page.findFirst({
    where: { workspaceId, parentId: parentId ?? null },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = (last?.position ?? -1) + 1;

  const page = await prisma.page.create({
    data: {
      workspaceId,
      parentId: parentId ?? null,
      title,
      kind: "database",
      position,
      createdById: userId,
      projectId: projectId ?? null,
    },
  });

  const statusOptions = [opt("할 일", "gray"), opt("진행 중", "blue"), opt("완료", "green")];
  const priorityOptions = [opt("낮음", "gray"), opt("보통", "yellow"), opt("높음", "red")];

  await prisma.dbProperty.create({
    data: { databasePageId: page.id, name: "이름", type: "text", position: 0 },
  });
  const statusProp = await prisma.dbProperty.create({
    data: {
      databasePageId: page.id,
      name: "상태",
      type: "select",
      position: 1,
      config: { options: statusOptions },
    },
  });
  await prisma.dbProperty.create({
    data: {
      databasePageId: page.id,
      name: "우선순위",
      type: "select",
      position: 2,
      config: { options: priorityOptions },
    },
  });
  await prisma.dbProperty.create({
    data: { databasePageId: page.id, name: "담당자", type: "text", position: 3 },
  });
  await prisma.dbProperty.create({
    data: { databasePageId: page.id, name: "마감일", type: "date", position: 4 },
  });

  await prisma.dbView.create({
    data: { databasePageId: page.id, name: "표", type: "table", position: 0 },
  });
  await prisma.dbView.create({
    data: {
      databasePageId: page.id,
      name: "보드",
      type: "kanban",
      position: 1,
      config: { groupBy: statusProp.id },
    },
  });

  // 새 보드는 빈 상태로 시작한다(예시 더미 행을 심지 않음).
  return page;
}

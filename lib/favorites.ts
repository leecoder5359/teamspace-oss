// IO 모듈(prisma). 판정 없음 — 접근 판정은 라우트의 pageGuard 가 한다.
import { prisma } from "@/lib/prisma";

export async function listFavorites(userId: string, workspaceId: string) {
  return prisma.pageFavorite.findMany({
    where: { userId, page: { workspaceId, deletedAt: null } },
    orderBy: { position: "asc" },
    select: { pageId: true, position: true },
  });
}

/** 멱등: 이미 있으면 그대로 둔다(순서도 유지). 새 항목은 맨 뒤. */
export async function addFavorite(userId: string, pageId: string): Promise<void> {
  const last = await prisma.pageFavorite.findFirst({
    where: { userId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  await prisma.pageFavorite.upsert({
    where: { userId_pageId: { userId, pageId } },
    update: {},
    create: { userId, pageId, position: (last?.position ?? -1) + 1 },
  });
}

export async function removeFavorite(userId: string, pageId: string): Promise<void> {
  await prisma.pageFavorite.deleteMany({ where: { userId, pageId } });
}

/** position = order 안의 인덱스. 내 즐겨찾기가 아닌 id 는 updateMany 가 0건이라 무시된다. */
export async function reorderFavorites(userId: string, order: string[]): Promise<void> {
  await prisma.$transaction(
    order.map((pageId, i) =>
      prisma.pageFavorite.updateMany({ where: { userId, pageId }, data: { position: i } }),
    ),
  );
}

/** 같은 페이지는 한 행(시각만 갱신), 사람당 keep 개를 넘으면 오래된 것부터 삭제. */
export async function recordVisit(userId: string, pageId: string, keep = 20): Promise<void> {
  await prisma.pageVisit.upsert({
    where: { userId_pageId: { userId, pageId } },
    update: { visitedAt: new Date() },
    create: { userId, pageId },
  });
  const stale = await prisma.pageVisit.findMany({
    where: { userId },
    orderBy: [{ visitedAt: "desc" }, { id: "desc" }],
    skip: keep,
    select: { id: true },
  });
  if (stale.length) {
    await prisma.pageVisit.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
}

export async function listVisits(userId: string, workspaceId: string, limit: number) {
  return prisma.pageVisit.findMany({
    where: { userId, page: { workspaceId, deletedAt: null } },
    orderBy: { visitedAt: "desc" },
    take: limit,
    select: { pageId: true, visitedAt: true },
  });
}

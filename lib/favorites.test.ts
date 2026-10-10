// DB 기반 테스트 — DATABASE_URL 이 없으면 통째로 건너뛴다(기본 pnpm test 는 DB 없이 돈다).
// 격리 테스트 DB 에서만 돌릴 것. 자체 워크스페이스·유저·페이지를 만들고 afterAll 에서 지운다.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  addFavorite,
  removeFavorite,
  reorderFavorites,
  listFavorites,
  recordVisit,
  listVisits,
} from "./favorites";

describe.skipIf(!process.env.DATABASE_URL)("favorites·visits (DB)", () => {
  let ws: { id: string };
  let user: { id: string };
  const pages: string[] = [];

  beforeAll(async () => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ws = await prisma.workspace.create({ data: { name: `fav-test-${tag}` } });
    user = await prisma.user.create({ data: { email: `fav-${tag}@test.local`, name: "fav" } });
    for (let i = 0; i < 25; i++) {
      const p = await prisma.page.create({
        data: { workspaceId: ws.id, title: `p${i}`, kind: "doc", createdById: user.id },
      });
      pages.push(p.id);
    }
  });

  afterAll(async () => {
    if (ws) await prisma.workspace.delete({ where: { id: ws.id } }); // pages·favorites·visits cascade
    if (user) await prisma.user.delete({ where: { id: user.id } });
  });

  it("추가는 멱등, 순서는 PATCH 순서대로", async () => {
    await addFavorite(user.id, pages[0]);
    await addFavorite(user.id, pages[0]);
    await addFavorite(user.id, pages[1]);
    expect((await listFavorites(user.id, ws.id)).map((f) => f.pageId)).toEqual([pages[0], pages[1]]);
    await reorderFavorites(user.id, [pages[1], pages[0]]);
    expect((await listFavorites(user.id, ws.id)).map((f) => f.pageId)).toEqual([pages[1], pages[0]]);
    await removeFavorite(user.id, pages[1]);
    expect((await listFavorites(user.id, ws.id)).map((f) => f.pageId)).toEqual([pages[0]]);
  });

  it("같은 페이지는 한 행(최신 시각), 20개 초과는 오래된 것부터 삭제", async () => {
    for (const id of pages) await recordVisit(user.id, id, 20);
    await recordVisit(user.id, pages[24], 20);
    const all = await prisma.pageVisit.findMany({ where: { userId: user.id } });
    expect(all).toHaveLength(20);
    const recent = await listVisits(user.id, ws.id, 8);
    expect(recent).toHaveLength(8);
    expect(recent[0].pageId).toBe(pages[24]);
    expect(all.find((v) => v.pageId === pages[0])).toBeUndefined();
  });

  it("최근 방문은 요청한 워크스페이스 페이지만 돌려준다", async () => {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const other = await prisma.workspace.create({ data: { name: `fav-other-${tag}` } });
    try {
      const op = await prisma.page.create({ data: { workspaceId: other.id, title: "other", kind: "doc", createdById: user.id } });
      await recordVisit(user.id, op.id, 20);
      expect((await listVisits(user.id, ws.id, 20)).map((v) => v.pageId)).not.toContain(op.id);
      expect((await listVisits(user.id, other.id, 20)).map((v) => v.pageId)).toEqual([op.id]);
    } finally {
      await prisma.workspace.delete({ where: { id: other.id } });
    }
  });
});

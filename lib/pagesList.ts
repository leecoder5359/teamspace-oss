import { prisma } from "@/lib/prisma";
import { loadAccess, visibleOnly, projectAccess, type AccessIndex } from "@/lib/pageGuard";
import { effectiveRestricted } from "@/lib/pageAccess";
import { withTreeMeta } from "@/lib/pagesMeta";
import { archivedPageIds } from "@/lib/pageArchive";
import type { Ctx } from "@/lib/workspace";
import type { DocType } from "@/lib/docOrganize";

/**
 * 사이드바 트리 목록 — `GET /api/pages` 와 (ws) 레이아웃의 초기 주입(U7)이 같이 쓴다.
 * `updatedAt` 은 ISO 문자열로 돌려준다: 레이아웃이 클라이언트 컴포넌트로 넘기는 값과
 * fetch 의 JSON 이 같은 모양이어야 하이드레이션·타입이 어긋나지 않는다.
 */
export type SidebarPage = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  position: number;
  kind: "doc" | "database";
  projectId: string | null;
  updatedAt: string;
  visibility: "inherit" | "restricted";
  docType: DocType | null;
  childCount: number;
  isFavorite: boolean;
  restricted: boolean;
  restrictedSelf: boolean;
  /** 보관된 문서(F2). `archived` 옵션이 active 가 아닐 때만 실린다 — 기본 응답 모양은 그대로. */
  archived?: true;
};

/** active=보관 제외(기본) · only=보관함 · all=둘 다 */
export type ArchivedMode = "active" | "only" | "all";

/** archived=보관된 프로젝트(F10) — 제거하지 않고 표시만 달리한다(페이지가 미분류로 떨어지면 안 된다). */
export type SidebarProject = { id: string; name: string; archived: boolean };

export async function listPagesForSidebar(
  ctx: Ctx,
  access?: AccessIndex,
  opts: { archived?: ArchivedMode } = {},
): Promise<SidebarPage[]> {
  const mode = opts.archived ?? "active";
  const { workspaceId } = ctx;
  // 서로 의존하지 않는 조회는 함께 시작한다. 접근 인덱스는 호출자가 이미 만들었으면 재사용한다.
  const [pages, idx, projects, favs] = await Promise.all([
    prisma.page.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        // 보관(F2)은 조상 기반이라 DB 에서 거르지 않는다 — 아래에서 archivedSet 으로 거른다.
      },
      orderBy: [{ parentId: "asc" }, { position: "asc" }],
      select: { id: true, title: true, icon: true, parentId: true, position: true, kind: true, projectId: true, updatedAt: true, visibility: true, docType: true, archivedAt: true },
    }),
    // D3: 사이드바·팔레트·검색 후보가 전부 이 목록을 쓴다 — 여기서 새면 제목이 통째로 샌다.
    access ?? loadAccess(ctx),
    /* D3 후속: 화면에 자물쇠를 그릴 수 있게 '비공개인지'를 함께 준다.
       `restrictedSelf` 는 잠금이 이 페이지에서 시작됐는지(트리에서 자손마다 자물쇠를 겹쳐 그리지 않으려고). */
    prisma.project.findMany({ where: { workspaceId }, select: { id: true, visibility: true } }),
    // 사이드바 트리용: 내 즐겨찾기 여부
    prisma.pageFavorite.findMany({ where: { userId: ctx.userId }, select: { pageId: true } }),
  ]);
  // 보관(F2): 사이드바·팔레트·GET /api/pages 가 모두 이 목록을 쓰므로 거르는 곳은 여기 한 곳.
  // 보이지 않는 조상의 보관도 후손에 적용되어야 하므로 접근 필터 전의 전체 목록으로 계산한다.
  const archivedSet = archivedPageIds(pages);
  const visibleAll = visibleOnly(idx, pages);
  // 잠금 상속은 보관 필터 전의 전체 노드로 계산한다 — 보관된 부모의 잠금이 자식에서 사라지면 안 된다.
  const nodes = visibleAll.map((p) => ({
    id: p.id,
    parentId: p.parentId,
    projectId: p.projectId,
    createdById: "",
    visibility: p.visibility,
  }));
  const all = effectiveRestricted(nodes, projects);
  const own = effectiveRestricted(nodes, projects, { ownOnly: true });

  // only(보관함)는 보관한 문서 자체(루트)만, active 는 집합 밖, all 은 전부.
  const visible =
    mode === "active"
      ? visibleAll.filter((p) => !archivedSet.has(p.id))
      : mode === "only"
        ? visibleAll.filter((p) => p.archivedAt)
        : visibleAll;
  const withMeta = withTreeMeta(visible, new Set(favs.map((f) => f.pageId)));
  return withMeta.map((row) => {
    const p = { ...row } as Omit<typeof row, "archivedAt"> & { archivedAt?: Date | null };
    delete p.archivedAt; // 내부 판정용 — 응답에는 싣지 않는다
    return {
    ...p,
    ...(mode !== "active" && archivedSet.has(p.id) ? { archived: true as const } : {}),
    updatedAt: p.updatedAt.toISOString(),
    restricted: all.has(p.id),
    restrictedSelf: own.has(p.id),
    };
  });
}

/**
 * 사이드바 그룹용 프로젝트 — `GET /api/projects` 와 같은 순서(position asc)·같은 잠금 필터.
 * 그 라우트는 카드 지표까지 집계하므로 사이드바엔 id·name 만 가볍게 읽는다.
 * 잠긴 프로젝트는 이름 자체가 정보라 빼야 한다(D3) — 그래서 workspaceId 가 아닌 ctx 를 받는다.
 */
export async function listProjectsForSidebar(ctx: Ctx, access?: AccessIndex): Promise<SidebarProject[]> {
  const [projects, idx] = await Promise.all([
    prisma.project.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { position: "asc" },
      select: { id: true, name: true, archivedAt: true },
    }),
    access ?? loadAccess(ctx),
  ]);
  return projects.filter((p) => projectAccess(idx, p.id) !== "none").map(({ id, name, archivedAt }) => ({ id, name, archived: archivedAt != null }));
}

/* =====================================================================
   페이지·프로젝트 권한 강제 (격차 D3) — 라우트가 쓰는 서버 측 게이트.

   판정은 전부 순수 함수(lib/pageAccess)에 있고, 여기서는 그 판정에 필요한
   데이터를 모아 오고 HTTP 응답으로 옮기는 일만 한다.

   두 가지 원칙:
   - **없는 것처럼 보인다.** 볼 수 없는 페이지는 403 이 아니라 **404** 다.
     403 은 "여기 뭔가 있는데 너는 못 본다" 를 알려 주므로, 제목만으로도
     새는 정보(인사·평가·계약)를 그대로 흘린다. 볼 수는 있는데 고칠 수 없을
     때만 403 이다.
   - **목록은 필터, 단건은 게이트.** 어느 쪽도 빠뜨리면 안 된다 — 단건만 막으면
     목록·검색·그래프·내보내기에서 제목이 새고, 목록만 필터하면 id 를 아는
     사람이 바로 읽는다.
   ===================================================================== */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Ctx } from "@/lib/workspace";
import {
  buildAccessIndex,
  pageAccess,
  projectAccess,
  type AccessIndex,
  type AccessLevel,
} from "@/lib/pageAccess";

export type { AccessIndex } from "@/lib/pageAccess";
export { pageAccess, projectAccess, canManageGrants, canManageProjectGrants } from "@/lib/pageAccess";

/**
 * 이 요청의 접근 색인을 만든다.
 *
 * 페이지 전체(id·부모·프로젝트·작성자·visibility)를 한 번에 읽는다 — 조상 사슬을
 * 따라 올라가야 하므로 어차피 트리가 필요하고, 이 규모(수백 행)에서 왕복을 줄이는
 * 쪽이 싸다. 부여는 **나에게 해당하는 것만** 가져온다(남의 부여는 판정에 안 쓴다).
 *
 * ## 규모 (실측 2026-08-09 — 다시 재지 말 것)
 *
 * 버릴 워크스페이스에 페이지를 늘려 가며 잰 중앙값(로컬 Postgres, 깊이 5 사슬):
 *
 *     페이지 200개    loadAccess 1.7ms    조상 사슬만(재귀 CTE) 0.4ms
 *     페이지 2,000개  loadAccess 3.0ms    조상 사슬만 0.5ms
 *     페이지 20,000개 loadAccess 21.9ms   조상 사슬만 2.4ms
 *
 * 현재 워크스페이스는 180행이라 요청당 ~1.7ms — **지금 최적화할 이유가 없다.**
 * 조상 사슬만 읽으면 10배 빠르지만 그걸로 바꾸지 않은 이유가 중요하다: 이 함수가
 * 돌려주는 색인은 단건 게이트에만 쓰이지 않고 `visibleOnly`(목록·검색·내보내기)
 * 필터에도 그대로 넘어간다. 색인에 없는 페이지는 판정이 `none` 이 되므로, 부분
 * 색인으로 바꾸는 순간 **목록에서 문서가 조용히 사라지는** 실패가 된다 — D3 에서
 * 가장 피하려던 종류의 버그다. 그래서 부분 색인은 함수를 갈라 38개 호출부를 전수
 * 감사한 다음에나 손댈 일이고, 20,000행(현재의 100배)에서도 22ms 라 그럴 값이
 * 아직 없다.
 *
 * 같은 요청에서 두 번 판정해야 하면 캐시를 두지 말고 `gatePage(idx, ...)` 로
 * **색인을 재사용**한다(요청 캐시는 '검사→변경→재검사' 흐름에서 낡은 판정을
 * 되돌려 주는 함정이 있다). 두 번 읽던 자리는 relation 속성 생성 하나였고
 * 그렇게 고쳤다.
 */
export async function loadAccess(ctx: Ctx): Promise<AccessIndex> {
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspaceId, userId: ctx.userId },
    select: { teamId: true },
  });
  const teamId = member?.teamId ?? null;
  const mine = [{ userId: ctx.userId }, ...(teamId ? [{ teamId }] : [])];

  const [pages, projects, pageGrants, projectGrants] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { id: true, parentId: true, projectId: true, createdById: true, visibility: true },
    }),
    prisma.project.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, visibility: true } }),
    prisma.pageGrant.findMany({
      where: { page: { workspaceId: ctx.workspaceId }, OR: mine },
      select: { pageId: true, userId: true, teamId: true, level: true },
    }),
    prisma.projectGrant.findMany({
      where: { project: { workspaceId: ctx.workspaceId }, OR: mine },
      select: { projectId: true, userId: true, teamId: true, level: true },
    }),
  ]);

  return buildAccessIndex({
    viewer: { userId: ctx.userId, teamId, role: ctx.role },
    pages,
    projects,
    pageGrants,
    projectGrants,
  });
}

/**
 * 게이트가 "없다" 고 답할 때 쓰는 표준 404 — 다른 라우트도 "이 대상은 없거나
 * 접근 불가" 를 이 게이트와 **완전히 같은 몸으로** 말하고 싶으면 새로 문자열을
 * 베끼지 말고 이 함수를 그대로 재사용한다(예: rows/[id]/move — 대상 보드가
 * 존재하지 않는지/다른 워크스페이스인지/삭제됐는지/볼 수 없는지를 구분되게
 * 알려주면 그 자체로 정보가 샌다).
 */
export const notFound = () =>
  NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 });
export const forbidden = () =>
  NextResponse.json({ error: "이 페이지를 편집할 권한이 없습니다." }, { status: 403 });

export type PageGate = { idx: AccessIndex; level: AccessLevel } | { err: NextResponse };

/**
 * 페이지 하나에 대한 게이트.
 *
 *   const gate = await requirePage(ctx, id, "edit");
 *   if ("err" in gate) return gate.err;
 */
export async function requirePage(ctx: Ctx, pageId: string, min: "view" | "edit"): Promise<PageGate> {
  const idx = await loadAccess(ctx);
  return gatePage(idx, pageId, min);
}

/** 이미 색인을 만들어 둔 라우트용(같은 요청에서 여러 번 판정할 때). */
export function gatePage(idx: AccessIndex, pageId: string, min: "view" | "edit"): PageGate {
  const level = pageAccess(idx, pageId);
  if (level === "none") return { err: notFound() };
  if (min === "edit" && level !== "edit") return { err: forbidden() };
  return { idx, level };
}

/** 프로젝트 게이트 — 프로젝트 설정·프로젝트 스코프 생성에 쓴다. */
export async function requireProject(
  ctx: Ctx,
  projectId: string,
  min: "view" | "edit",
): Promise<{ idx: AccessIndex; level: AccessLevel } | { err: NextResponse }> {
  const idx = await loadAccess(ctx);
  const level = projectAccess(idx, projectId);
  if (level === "none") return { err: NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 }) };
  if (min === "edit" && level !== "edit")
    return { err: NextResponse.json({ error: "이 프로젝트를 편집할 권한이 없습니다." }, { status: 403 }) };
  return { idx, level };
}

/** 목록 필터 — 볼 수 없는 페이지를 걸러낸다. */
export function visibleOnly<T extends { id: string }>(idx: AccessIndex, rows: T[]): T[] {
  return rows.filter((r) => pageAccess(idx, r.id) !== "none");
}

/** 페이지 id 로 참조하는 목록(코멘트·행·일정 등) 필터. */
export function visibleByPageId<T>(idx: AccessIndex, rows: T[], pageIdOf: (r: T) => string | null): T[] {
  return rows.filter((r) => {
    const id = pageIdOf(r);
    return id === null || pageAccess(idx, id) !== "none";
  });
}

/**
 * 이 페이지가 **어떤 식으로든 제한돼 있나**(자기 자신·조상·프로젝트 중 하나라도
 * restricted). 뷰어가 없는 자리 — 알림 브로드캐스트처럼 "누구에게 갈지 모르는"
 * 경로에서 쓴다(D3 후속).
 *
 * 판정에 사람이 없으므로 "볼 수 있나" 가 아니라 "아무나 봐도 되나" 를 묻는다.
 * 하나라도 잠겨 있으면 채널 전체로 내용을 뿌리지 않는다.
 */
export async function isRestrictedPage(pageId: string): Promise<boolean> {
  const page = await prisma.page.findUnique({
    where: { id: pageId },
    select: { id: true, parentId: true, visibility: true, project: { select: { visibility: true } } },
  });
  if (!page) return true; // 모르면 보수적으로 — 없는 페이지의 내용을 뿌릴 이유가 없다
  if (page.visibility === "restricted") return true;
  if (page.project?.visibility === "restricted") return true;

  // 조상 사슬 — 부모가 잠겨 있으면 자식도 잠긴 것이다.
  let parentId = page.parentId;
  const seen = new Set<string>([page.id]);
  for (let i = 0; i < 50 && parentId; i++) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const p: { parentId: string | null; visibility: string; project: { visibility: string } | null } | null =
      await prisma.page.findUnique({
        where: { id: parentId },
        select: { parentId: true, visibility: true, project: { select: { visibility: true } } },
      });
    if (!p) break;
    if (p.visibility === "restricted" || p.project?.visibility === "restricted") return true;
    parentId = p.parentId;
  }
  return false;
}

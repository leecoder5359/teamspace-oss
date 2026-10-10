/* =====================================================================
   페이지·프로젝트 단위 접근 판정 (격차 D3) — 순수 함수. prisma 도 요청도 모른다.

   그동안 권한은 워크스페이스 3역할(viewer/editor/admin)뿐이었다. 멤버면 모든
   문서를 봤다는 뜻이고, 그래서 "이 문서는 아직 팀 일부만" 같은 게 불가능했다.

   모델(노션·구글문서와 같은 계보):
     - 페이지는 기본 `inherit` — 위로 올라가며 가장 가까운 결정자가 판정한다.
     - `restricted` 로 잠그면 그 페이지와 **자손 전체**가 잠긴다.
     - 부여(grant)는 더 **구체적인 쪽이 이긴다**: 자손의 부여 > 조상의 잠금,
       사용자 부여 > 팀 부여, 페이지 > 프로젝트.
     - **워크스페이스 역할이 천장이다.** viewer 에게 edit 를 부여해도 보기까지다.
       (역할은 "이 워크스페이스에서 무엇을 할 수 있나", 부여는 "어디를 볼 수 있나".
       천장을 안 두면 부여가 역할 승격 경로가 되어 RBAC 이 뚫린다.)

   확정된 정책 두 가지(2026-08-09, 사용자 결정):
     - **admin 은 우회한다.** 잠금(lockout)이 원천적으로 불가능해진다. 대신 이
       앱에 '관리자도 못 보는 비밀' 은 둘 수 없다는 뜻이고, 공유 UI 가 그 사실을 밝힌다.
     - **편집할 수 있으면 공유 범위도 정한다.** 문서를 만든 사람이 곧바로 범위를
       좁힐 수 있어야 실제로 쓰인다.
   ===================================================================== */

import type { Role } from "@/app/generated/prisma/enums";
import { ROLE_ORDER } from "@/lib/authz";

export type AccessLevel = "none" | "view" | "edit";
export type Visibility = "inherit" | "restricted";

export type PageNode = {
  id: string;
  parentId: string | null;
  projectId: string | null;
  createdById: string;
  visibility: Visibility;
};

export type ProjectNode = { id: string; visibility: Visibility };

/** 부여 한 건. userId·teamId 중 정확히 하나가 채워진다. */
export type PageGrantRow = { pageId: string; userId: string | null; teamId: string | null; level: "view" | "edit" };
export type ProjectGrantRow = { projectId: string; userId: string | null; teamId: string | null; level: "view" | "edit" };

export type Viewer = { userId: string; teamId: string | null; role: Role };

export type AccessInput = {
  viewer: Viewer;
  pages: PageNode[];
  projects: ProjectNode[];
  pageGrants: PageGrantRow[];
  projectGrants: ProjectGrantRow[];
};

export type AccessIndex = {
  viewer: Viewer;
  ceiling: AccessLevel;
  pages: Map<string, PageNode>;
  projects: Map<string, ProjectNode>;
  /** pageId → 이 뷰어에게 해당하는 최선의 부여 */
  pageGrant: Map<string, AccessLevel>;
  projectGrant: Map<string, AccessLevel>;
};

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };

/** 역할이 허용하는 최대치. 알 수 없는 역할은 아무것도 못 한다(방어적 — authz.roleAtLeast 와 같은 태도). */
function ceilingFor(role: Role): AccessLevel {
  if (ROLE_ORDER[role] === undefined) return "none";
  return role === "viewer" ? "view" : "edit";
}

function cap(level: AccessLevel, ceiling: AccessLevel): AccessLevel {
  return RANK[level] <= RANK[ceiling] ? level : ceiling;
}

/**
 * 뷰어에게 해당하는 부여만 남겨 대상별로 접는다.
 * 사용자 부여가 있으면 그것만 쓴다 — 팀 부여보다 **구체적**이므로, 팀에 edit 가
 * 있어도 나에게 view 를 주었다면 그건 좁히려는 의도다(최대치로 합치면 그 의도가 사라진다).
 */
function foldGrants<T extends { userId: string | null; teamId: string | null; level: "view" | "edit" }>(
  rows: T[],
  key: (r: T) => string,
  viewer: Viewer,
): Map<string, AccessLevel> {
  const user = new Map<string, AccessLevel>();
  const team = new Map<string, AccessLevel>();
  for (const r of rows) {
    const k = key(r);
    if (r.userId && r.userId === viewer.userId) {
      user.set(k, RANK[r.level] > RANK[user.get(k) ?? "none"] ? r.level : user.get(k)!);
    } else if (r.teamId && viewer.teamId && r.teamId === viewer.teamId) {
      team.set(k, RANK[r.level] > RANK[team.get(k) ?? "none"] ? r.level : team.get(k)!);
    }
  }
  return new Map([...team, ...user]); // 사용자 부여가 팀 부여를 덮어쓴다
}

/** 한 요청 안에서 여러 페이지를 판정하므로 색인을 한 번만 만든다. */
export function buildAccessIndex(input: AccessInput): AccessIndex {
  return {
    viewer: input.viewer,
    ceiling: ceilingFor(input.viewer.role),
    pages: new Map(input.pages.map((p) => [p.id, p])),
    projects: new Map(input.projects.map((p) => [p.id, p])),
    pageGrant: foldGrants(input.pageGrants, (r) => r.pageId, input.viewer),
    projectGrant: foldGrants(input.projectGrants, (r) => r.projectId, input.viewer),
  };
}

/**
 * 페이지 하나에 대한 접근 수준.
 *
 * 페이지에서 위로 올라가며 **처음 만나는 결정자**가 답을 낸다:
 *   ① 나에게 부여가 있다 → 그 수준
 *   ② restricted 다 → 내가 작성자면 편집, 아니면 none
 *   ③ 둘 다 아니면 부모로
 * 조상을 다 훑어도 결정자가 없으면 프로젝트가, 프로젝트도 없으면 역할이 답한다.
 */
export function pageAccess(idx: AccessIndex, pageId: string): AccessLevel {
  if (idx.ceiling === "none") return "none";
  if (idx.viewer.role === "admin") return "edit"; // 확정 정책: admin 우회
  const start = idx.pages.get(pageId);
  if (!start) return "none";

  const seen = new Set<string>();
  let node: PageNode | undefined = start;
  while (node && !seen.has(node.id)) {
    seen.add(node.id);
    const granted = idx.pageGrant.get(node.id);
    if (granted) return cap(granted, idx.ceiling);
    if (node.visibility === "restricted") {
      // 작성자는 자기가 잠근 문서에서 스스로를 잠그지 않는다.
      return node.createdById === idx.viewer.userId ? idx.ceiling : "none";
    }
    node = node.parentId ? idx.pages.get(node.parentId) : undefined;
  }

  // 조상 중 결정자가 없었다 → 프로젝트가 정한다.
  const projectId = start.projectId;
  if (projectId) {
    const level = projectGate(idx, projectId);
    // 프로젝트가 잠겨 있어도 그 문서를 만든 사람은 자기 문서를 잃지 않는다.
    if (level === "none" && start.createdById === idx.viewer.userId) return idx.ceiling;
    if (level !== null) return level;
  }
  return idx.ceiling;
}

/** 프로젝트 게이트: 부여가 있으면 그 수준, 잠겨 있으면 none, 아니면 null(=상관없음). */
function projectGate(idx: AccessIndex, projectId: string): AccessLevel | null {
  const granted = idx.projectGrant.get(projectId);
  if (granted) return cap(granted, idx.ceiling);
  const project = idx.projects.get(projectId);
  if (project?.visibility === "restricted") return "none";
  return null;
}

/** 프로젝트 자체(설정·문서 목록)에 대한 접근 수준. */
export function projectAccess(idx: AccessIndex, projectId: string): AccessLevel {
  if (idx.ceiling === "none") return "none";
  if (idx.viewer.role === "admin") return "edit";
  return projectGate(idx, projectId) ?? idx.ceiling;
}

/** 공유 범위를 정할 수 있나 — 확정 정책상 '편집할 수 있으면' 이다. */
export function canManageGrants(idx: AccessIndex, pageId: string): boolean {
  return pageAccess(idx, pageId) === "edit";
}

/** 프로젝트의 공유 범위를 정할 수 있나. */
export function canManageProjectGrants(idx: AccessIndex, projectId: string): boolean {
  return projectAccess(idx, projectId) === "edit";
}

/**
 * 이 뷰어가 볼 수 없는 페이지 id. 행을 읽지 않는 자리(count 등)에서 where 의 `id: { notIn }` 으로 밀어 넣는다.
 * 색인(loadAccess)이 워크스페이스 페이지 전체를 담으므로 '색인 밖 = none' 인 새 페이지만 빠질 수 있다(경합 창).
 */
export function hiddenPageIds(idx: AccessIndex): string[] {
  if (idx.viewer?.role === "admin") return []; // admin 우회(pageAccess 와 같은 정책)
  return [...(idx.pages?.keys() ?? [])].filter((id) => pageAccess(idx, id) === "none");
}

/** 목록 필터링용 — 볼 수 있는 페이지만 남긴다. */
export function filterVisible<T extends { id: string }>(idx: AccessIndex, pages: T[]): T[] {
  return pages.filter((p) => pageAccess(idx, p.id) !== "none");
}

/**
 * 화면에 **자물쇠를 그릴 페이지**들 (D3 후속).
 *
 * 접근 판정과 목적이 다르다. 여기서는 사람이 아니라 "이 페이지가 모두에게
 * 열려 있나" 를 묻는다 — 소유자 화면에서 어떤 문서가 잠겨 있는지 목록만
 * 봐서는 알 수 없던 문제를 메운다.
 *
 * @param ownOnly 잠금이 **이 페이지에서 시작된 것**만(조상 상속 제외).
 *                트리에서 자손마다 자물쇠를 겹쳐 그리지 않으려면 이걸 쓴다.
 */
export function effectiveRestricted(
  pages: PageNode[],
  projects: ProjectNode[],
  opts?: { ownOnly?: boolean },
): Set<string> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const lockedProject = new Set(projects.filter((p) => p.visibility === "restricted").map((p) => p.id));
  const out = new Set<string>();

  for (const p of pages) {
    const own = p.visibility === "restricted" || (p.projectId ? lockedProject.has(p.projectId) : false);
    if (own) {
      out.add(p.id);
      continue;
    }
    if (opts?.ownOnly) continue;

    // 조상 사슬 — 하나라도 잠겨 있으면 이 페이지도 잠긴 것으로 보인다.
    let cur = p.parentId ? byId.get(p.parentId) : undefined;
    const seen = new Set<string>([p.id]);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.visibility === "restricted" || (cur.projectId ? lockedProject.has(cur.projectId) : false)) {
        out.add(p.id);
        break;
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return out;
}

import { describe, it, expect } from "vitest";
import {
  buildAccessIndex,
  pageAccess,
  projectAccess,
  canManageGrants,
  effectiveRestricted,
  type AccessInput,
  type PageNode,
  type ProjectNode,
} from "@/lib/pageAccess";

/* 등장인물
   - alice(editor, 팀 T1) · bob(editor, 팀 없음) · vera(viewer) · adam(admin)
   페이지 트리
   - root(공개) ├ child(공개) └ secret(비공개, 작성자 alice) ├ under(공개, secret 아래) */
const BASE: AccessInput = {
  viewer: { userId: "bob", teamId: null, role: "editor" },
  pages: [
    { id: "root", parentId: null, projectId: null, createdById: "alice", visibility: "inherit" },
    { id: "child", parentId: "root", projectId: null, createdById: "alice", visibility: "inherit" },
    { id: "secret", parentId: "root", projectId: null, createdById: "alice", visibility: "restricted" },
    { id: "under", parentId: "secret", projectId: null, createdById: "alice", visibility: "inherit" },
  ],
  projects: [],
  pageGrants: [],
  projectGrants: [],
};

const idx = (over: Partial<AccessInput> = {}) => buildAccessIndex({ ...BASE, ...over });
const as = (userId: string, role: AccessInput["viewer"]["role"], teamId: string | null = null) => ({
  viewer: { userId, teamId, role },
});

describe("pageAccess — 기본(비공개가 없을 때)", () => {
  it("editor 는 편집, viewer 는 보기", () => {
    expect(pageAccess(idx(), "root")).toBe("edit");
    expect(pageAccess(idx(as("vera", "viewer")), "root"), "viewer 는 워크스페이스 역할이 천장").toBe("view");
  });

  it("없는 페이지는 none", () => {
    expect(pageAccess(idx(), "존재하지 않음")).toBe("none");
  });
});

describe("pageAccess — 비공개 페이지", () => {
  it("부여받지 못한 사람은 none", () => {
    expect(pageAccess(idx(), "secret")).toBe("none");
  });

  it("작성자는 항상 편집할 수 있다", () => {
    expect(pageAccess(idx(as("alice", "editor")), "secret")).toBe("edit");
  });

  it("admin 은 우회한다(잠금 방지 — 확정된 정책)", () => {
    expect(pageAccess(idx(as("adam", "admin")), "secret")).toBe("edit");
  });

  it("비공개는 자손에게 상속된다", () => {
    expect(pageAccess(idx(), "under")).toBe("none");
  });

  it("형제·부모는 영향을 받지 않는다", () => {
    expect(pageAccess(idx(), "child")).toBe("edit");
    expect(pageAccess(idx(), "root")).toBe("edit");
  });
});

describe("pageAccess — 부여(grant)", () => {
  const grants = [{ pageId: "secret", userId: "bob", teamId: null, level: "view" as const }];

  it("사용자 부여로 열린다", () => {
    expect(pageAccess(idx({ pageGrants: grants }), "secret")).toBe("view");
  });

  it("부여는 자손에게도 상속된다", () => {
    expect(pageAccess(idx({ pageGrants: grants }), "under")).toBe("view");
  });

  it("팀 부여도 통한다", () => {
    const teamGrant = [{ pageId: "secret", userId: null, teamId: "T1", level: "edit" as const }];
    expect(pageAccess(idx({ ...as("alice", "editor", "T1"), pageGrants: teamGrant }), "secret")).toBe("edit");
    // 다른 팀·무팀은 그대로 막힌다
    expect(pageAccess(idx({ pageGrants: teamGrant }), "secret")).toBe("none");
  });

  it("사용자 부여가 팀 부여를 이긴다(더 구체적인 쪽)", () => {
    const mixed = [
      { pageId: "secret", userId: null, teamId: "T1", level: "edit" as const },
      { pageId: "secret", userId: "carl", teamId: null, level: "view" as const },
    ];
    expect(pageAccess(idx({ ...as("carl", "editor", "T1"), pageGrants: mixed }), "secret")).toBe("view");
  });

  it("워크스페이스 역할이 천장이다 — viewer 에게 edit 를 줘도 보기까지", () => {
    const g = [{ pageId: "secret", userId: "vera", teamId: null, level: "edit" as const }];
    expect(pageAccess(idx({ ...as("vera", "viewer"), pageGrants: g }), "secret")).toBe("view");
  });

  it("자손에 부여하면 조상이 잠겨 있어도 그 자손만 열린다", () => {
    const g = [{ pageId: "under", userId: "bob", teamId: null, level: "edit" as const }];
    const i = idx({ pageGrants: g });
    expect(pageAccess(i, "under")).toBe("edit");
    expect(pageAccess(i, "secret"), "조상은 여전히 잠겨 있다").toBe("none");
  });

  it("공개 페이지에 부여하면 역할보다 넓힐 수 있다(viewer→edit 은 여전히 천장에 걸림)", () => {
    const g = [{ pageId: "child", userId: "vera", teamId: null, level: "edit" as const }];
    expect(pageAccess(idx({ ...as("vera", "viewer"), pageGrants: g }), "child")).toBe("view");
  });
});

describe("projectAccess — 프로젝트 단위", () => {
  const withProject: Partial<AccessInput> = {
    pages: [
      { id: "p1", parentId: null, projectId: "PR", createdById: "alice", visibility: "inherit" },
      { id: "p2", parentId: null, projectId: "OPEN", createdById: "alice", visibility: "inherit" },
    ],
    projects: [
      { id: "PR", visibility: "restricted" },
      { id: "OPEN", visibility: "inherit" },
    ],
  };

  it("비공개 프로젝트의 페이지는 막힌다", () => {
    expect(pageAccess(idx(withProject), "p1")).toBe("none");
    expect(pageAccess(idx(withProject), "p2")).toBe("edit");
  });

  it("프로젝트 부여로 그 안의 페이지가 전부 열린다", () => {
    const i = idx({
      ...withProject,
      projectGrants: [{ projectId: "PR", userId: "bob", teamId: null, level: "view" }],
    });
    expect(pageAccess(i, "p1")).toBe("view");
    expect(projectAccess(i, "PR")).toBe("view");
  });

  it("페이지 부여가 프로젝트 잠금보다 우선한다(더 구체적인 쪽)", () => {
    const i = idx({
      ...withProject,
      pageGrants: [{ pageId: "p1", userId: "bob", teamId: null, level: "edit" }],
    });
    expect(pageAccess(i, "p1")).toBe("edit");
  });

  it("admin 은 프로젝트도 우회한다", () => {
    expect(pageAccess(idx({ ...withProject, ...as("adam", "admin") }), "p1")).toBe("edit");
    expect(projectAccess(idx({ ...withProject, ...as("adam", "admin") }), "PR")).toBe("edit");
  });

  it("프로젝트가 비공개여도 페이지의 작성자는 자기 문서를 본다", () => {
    expect(pageAccess(idx({ ...withProject, ...as("alice", "editor") }), "p1")).toBe("edit");
  });
});

describe("canManageGrants — 공유 설정 권한(확정 정책: 편집할 수 있으면 공유도 정한다)", () => {
  it("편집 권한이 있으면 공유를 정할 수 있다", () => {
    expect(canManageGrants(idx(), "child")).toBe(true);
    expect(canManageGrants(idx(as("alice", "editor")), "secret")).toBe(true);
  });

  it("보기만 되는 사람은 못 정한다", () => {
    const g = [{ pageId: "secret", userId: "bob", teamId: null, level: "view" as const }];
    expect(canManageGrants(idx({ pageGrants: g }), "secret")).toBe(false);
  });

  it("viewer 는 어디서도 못 정한다", () => {
    expect(canManageGrants(idx(as("vera", "viewer")), "root")).toBe(false);
  });

  it("admin 은 어디서든 정할 수 있다", () => {
    expect(canManageGrants(idx(as("adam", "admin")), "secret")).toBe(true);
  });
});

describe("pageAccess — 방어", () => {
  it("부모 순환이 있어도 멈춘다", () => {
    const cyclic = idx({
      pages: [
        { id: "a", parentId: "b", projectId: null, createdById: "alice", visibility: "inherit" },
        { id: "b", parentId: "a", projectId: null, createdById: "alice", visibility: "inherit" },
      ],
    });
    expect(pageAccess(cyclic, "a")).toBe("edit");
  });

  it("부모가 목록에 없으면(권한 밖·삭제됨) 거기서 멈추고 역할로 판정한다", () => {
    const orphan = idx({
      pages: [{ id: "solo", parentId: "사라진부모", projectId: null, createdById: "alice", visibility: "inherit" }],
    });
    expect(pageAccess(orphan, "solo")).toBe("edit");
  });

  it("알 수 없는 역할은 아무것도 못 한다", () => {
    const i = buildAccessIndex({ ...BASE, viewer: { userId: "x", teamId: null, role: "이상한값" as never } });
    expect(pageAccess(i, "root")).toBe("none");
  });
});

describe("effectiveRestricted — 자물쇠를 어디에 그릴 것인가", () => {
  const pages: PageNode[] = [
    { id: "open", parentId: null, projectId: null, createdById: "u", visibility: "inherit" },
    { id: "locked", parentId: null, projectId: null, createdById: "u", visibility: "restricted" },
    { id: "child", parentId: "locked", projectId: null, createdById: "u", visibility: "inherit" },
    { id: "grand", parentId: "child", projectId: null, createdById: "u", visibility: "inherit" },
    { id: "inProj", parentId: null, projectId: "P", createdById: "u", visibility: "inherit" },
  ];
  const projects: ProjectNode[] = [{ id: "P", visibility: "restricted" }];

  it("스스로 잠긴 페이지", () => {
    expect(effectiveRestricted(pages, projects).has("locked")).toBe(true);
  });

  it("잠긴 조상의 자손도 잠긴 것으로 본다", () => {
    const r = effectiveRestricted(pages, projects);
    expect(r.has("child")).toBe(true);
    expect(r.has("grand")).toBe(true);
  });

  it("잠긴 프로젝트에 속하면 잠긴 것", () => {
    expect(effectiveRestricted(pages, projects).has("inProj")).toBe(true);
  });

  it("열린 페이지는 아니다", () => {
    expect(effectiveRestricted(pages, projects).has("open")).toBe(false);
  });

  it("원인이 자기 자신인지 구분할 수 있다(자물쇠를 겹쳐 그리지 않게)", () => {
    const own = effectiveRestricted(pages, projects, { ownOnly: true });
    expect(own.has("locked")).toBe(true);
    expect(own.has("child")).toBe(false);
    expect(own.has("inProj")).toBe(true); // 프로젝트 잠금은 이 페이지에서 시작된 것으로 본다
  });

  it("부모 순환이 있어도 멈춘다", () => {
    const cyclic: PageNode[] = [
      { id: "a", parentId: "b", projectId: null, createdById: "u", visibility: "inherit" },
      { id: "b", parentId: "a", projectId: null, createdById: "u", visibility: "inherit" },
    ];
    expect(effectiveRestricted(cyclic, []).size).toBe(0);
  });
});

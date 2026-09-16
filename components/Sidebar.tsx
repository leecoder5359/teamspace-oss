"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Icon } from "./ws/icons";
import type { SessionUser } from "./AppShell";

type Theme = "light" | "dark";

type FlatPage = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  position: number;
  kind: "doc" | "database";
  projectId: string | null;
  /** D3 후속: 이 페이지가 모두에게 열려 있지 않다(조상·프로젝트 상속 포함) */
  restricted?: boolean;
  /** 잠금이 이 페이지에서 시작됐나 — 자손마다 자물쇠를 겹쳐 그리지 않으려고 */
  restrictedSelf?: boolean;
};
type PageNode = FlatPage & { children: PageNode[] };

const NONE = "__none__";
const LS_COLLAPSED = "ws-sidebar-collapsed";

function buildTree(flat: FlatPage[]): PageNode[] {
  const byId = new Map<string, PageNode>();
  flat.forEach((p) => byId.set(p.id, { ...p, children: [] }));
  const roots: PageNode[] = [];
  byId.forEach((node) => {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRec = (nodes: PageNode[]) => {
    nodes.sort((a, b) => a.position - b.position);
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

type Group = { key: string; name: string; isProject: boolean; boards: FlatPage[]; roots: PageNode[] };

export default function Sidebar({
  rail,
  theme,
  onToggleRail,
  onToggleTheme,
  onNavigate,
  sessionUser = null,
}: {
  rail: boolean;
  theme: Theme;
  onToggleRail: () => void;
  onToggleTheme: () => void;
  onNavigate?: () => void;
  sessionUser?: SessionUser;
}) {
  const [flat, setFlat] = useState<FlatPage[]>([]);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ node: FlatPage; hasChildren: boolean; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [dropKey, setDropKey] = useState<string | null>(null);
  const persistRef = useRef(false);
  const pathname = usePathname();
  const router = useRouter();

  const activeId = pathname.startsWith("/p/") ? pathname.slice(3) : null;

  // 알림 미읽음 배지 (W6): 60초 폴링 + 경로 변경 시 갱신
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch("/api/notifications?unread=1&limit=1", { cache: "no-store" });
        if (r.ok && alive) setUnread(((await r.json()) as { unread: number }).unread ?? 0);
      } catch {
        /* 무해 */
      }
    };
    void tick();
    const iv = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [pathname]);

  const load = useCallback(async () => {
    const [pagesRes, projectsRes] = await Promise.all([
      fetch("/api/pages", { cache: "no-store" }),
      fetch("/api/projects", { cache: "no-store" }),
    ]);
    if (!pagesRes.ok) return;
    const data = (await pagesRes.json()) as { pages: FlatPage[] };
    setFlat(data.pages);
    if (projectsRes.ok) {
      const pj = (await projectsRes.json()) as { projects: { id: string; name: string }[] };
      setProjects(pj.projects.map((p) => ({ id: p.id, name: p.name })));
    }
    setLoaded(true);
  }, []);

  // 접힘 상태 복원(최초 1회)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_COLLAPSED);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
    persistRef.current = true;
  }, []);

  // 접힘 상태 저장
  useEffect(() => {
    if (!persistRef.current) return;
    try {
      localStorage.setItem(LS_COLLAPSED, JSON.stringify([...collapsed]));
    } catch {
      /* ignore */
    }
  }, [collapsed]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const onChanged = () => load();
    window.addEventListener("pages:changed", onChanged);
    return () => window.removeEventListener("pages:changed", onChanged);
  }, [load]);

  // 컨텍스트 메뉴: 바깥 클릭/스크롤 시 닫기
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    await load();
    window.dispatchEvent(new Event("pages:changed"));
  }, [load]);

  // ── 변이(mutation) ──
  const createPage = useCallback(
    async (opts: { parentId?: string | null; projectId?: string | null; title?: string; folder?: boolean }) => {
      setBusy(true);
      try {
        const res = await fetch("/api/pages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: opts.title ?? (opts.folder ? "새 폴더" : "제목 없음"),
            parentId: opts.parentId ?? null,
            projectId: opts.projectId ?? null,
          }),
        });
        if (res.ok) {
          const { page } = (await res.json()) as { page: { id: string } };
          if (opts.parentId) setCollapsed((prev) => { const n = new Set(prev); n.delete(opts.parentId!); return n; });
          await refresh();
          if (!opts.folder) {
            router.push(`/p/${page.id}`);
            onNavigate?.();
          } else {
            // 폴더는 바로 이름 편집 모드로
            setRenaming(page.id);
            setDraft("새 폴더");
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [refresh, router, onNavigate],
  );

  const createBoard = useCallback(
    async (projectId: string | null) => {
      setBusy(true);
      try {
        const res = await fetch("/api/databases", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "태스크 보드", projectId }),
        });
        if (res.ok) {
          const { page } = (await res.json()) as { page: { id: string } };
          await refresh();
          router.push(`/p/${page.id}?view=kanban`);
          onNavigate?.();
        }
      } finally {
        setBusy(false);
      }
    },
    [refresh, router, onNavigate],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      const t = title.trim();
      setRenaming(null);
      if (!t) return;
      await fetch(`/api/pages/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (node: { id: string; title: string; hasChildren: boolean }) => {
      const msg = node.hasChildren
        ? `"${node.title || "제목 없음"}" 와(과) 그 안의 모든 항목을 삭제할까요?`
        : `"${node.title || "제목 없음"}" 을(를) 삭제할까요?`;
      if (!window.confirm(msg)) return;
      await fetch(`/api/pages/${node.id}${node.hasChildren ? "?recursive=1" : ""}`, { method: "DELETE" });
      if (activeId === node.id) {
        router.push("/dashboard");
        onNavigate?.();
      }
      await refresh();
    },
    [refresh, activeId, router, onNavigate],
  );

  const move = useCallback(
    async (id: string, parentId: string | null, projectId: string | null) => {
      if (id === parentId) return;
      await fetch(`/api/pages/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentId, projectId }),
      });
      await refresh();
    },
    [refresh],
  );

  // ── 그룹 구성: 문서/폴더는 parentId 트리, 루트를 projectId로 그룹화 ──
  const groups = useMemo<Group[]>(() => {
    const docPages = flat.filter((p) => p.kind === "doc");
    const databases = flat.filter((p) => p.kind === "database");
    const roots = buildTree(docPages);

    const rootsByProject = new Map<string, PageNode[]>();
    for (const r of roots) {
      const k = r.projectId ?? NONE;
      (rootsByProject.get(k) ?? rootsByProject.set(k, []).get(k)!).push(r);
    }
    const boardsByProject = new Map<string, FlatPage[]>();
    for (const d of databases) {
      const k = d.projectId ?? NONE;
      (boardsByProject.get(k) ?? boardsByProject.set(k, []).get(k)!).push(d);
    }

    const out: Group[] = [];
    for (const p of projects) {
      out.push({
        key: p.id,
        name: p.name,
        isProject: true,
        boards: boardsByProject.get(p.id) ?? [],
        roots: rootsByProject.get(p.id) ?? [],
      });
    }
    const nr = rootsByProject.get(NONE) ?? [];
    const nb = boardsByProject.get(NONE) ?? [];
    if (nr.length || nb.length) {
      out.push({ key: NONE, name: "미분류", isProject: false, boards: nb, roots: nr });
    }
    return out;
  }, [flat, projects]);

  const collapseTitle = rail ? "사이드바 펼치기" : "사이드바 접기";
  const userName = sessionUser ? sessionUser.name ?? sessionUser.email ?? "사용자" : "이호준";
  const userEmail = sessionUser ? sessionUser.email ?? "" : "you@example.com";
  const userInitials = userName.slice(0, 2);

  // ── 렌더: 문서/폴더 노드(재귀) ──
  const renderNode = (node: PageNode, projectKey: string, depth: number) => {
    const hasChildren = node.children.length > 0;
    const open = !collapsed.has(node.id);
    const active = node.id === activeId;
    const isRenaming = renaming === node.id;
    const isDrop = dropKey === node.id;

    return (
      <li key={node.id}>
        <div
          className={`ws-tree-row${active ? " active" : ""}${isDrop ? " drop-over" : ""}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={!isRenaming}
          onDragStart={(e) => {
            setDragId(node.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            setDragId(null);
            setDropKey(null);
          }}
          onDragOver={(e) => {
            if (!dragId || dragId === node.id) return;
            e.preventDefault();
            if (dropKey !== node.id) setDropKey(node.id);
          }}
          onDragLeave={() => setDropKey((k) => (k === node.id ? null : k))}
          onDrop={(e) => {
            e.preventDefault();
            if (dragId && dragId !== node.id) void move(dragId, node.id, node.projectId);
            setDragId(null);
            setDropKey(null);
          }}
        >
          <button
            className="ws-tree-twist"
            onClick={() => (hasChildren ? toggle(node.id) : undefined)}
            aria-label={hasChildren ? (open ? "접기" : "펼치기") : undefined}
            tabIndex={hasChildren ? 0 : -1}
            style={{ visibility: hasChildren ? "visible" : "hidden" }}
          >
            <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
          </button>
          <span className="ws-tree-icon">
            {node.icon ?? (hasChildren ? "📁" : "📄")}
          </span>
          {/* D3 후속: 비공개 표시. 잠금이 시작된 지점에만 그린다 —
              자손마다 붙이면 트리가 자물쇠로 뒤덮여 오히려 안 읽힌다. */}
          {node.restrictedSelf && (
            <span
              title="비공개 — 부여받은 사람만 볼 수 있습니다(하위 문서도 함께)"
              style={{ display: "inline-flex", alignItems: "center", color: "#E0900F", marginRight: 2, flexShrink: 0 }}
            >
              <Icon name="lock" size={12} />
            </span>
          )}
          {isRenaming ? (
            <input
              className="ws-tree-rename"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void rename(node.id, draft);
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={() => void rename(node.id, draft)}
            />
          ) : (
            <Link href={`/p/${node.id}`} className="ws-tree-name" onClick={onNavigate} title={node.title || "제목 없음"}>
              {node.title || "제목 없음"}
            </Link>
          )}
          <span className="ws-row-actions">
            <button
              className="ws-icon-btn ws-row-act"
              title="문서 추가"
              onClick={(e) => {
                e.stopPropagation();
                void createPage({ parentId: node.id, projectId: node.projectId });
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              className="ws-icon-btn ws-row-act"
              title="더보기"
              onClick={(e) => {
                e.stopPropagation();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setMenu({ node, hasChildren, x: r.right, y: r.bottom + 4 });
              }}
            >
              <Icon name="dots" size={15} />
            </button>
          </span>
        </div>
        {hasChildren && open && (
          <ul className="ws-tree">{node.children.map((c) => renderNode(c, projectKey, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <aside className="ws-sidebar" aria-label="사이드바">
      {/* 회사 전환기 */}
      <div className="ws-side-top">
        <button className="ws-company" title="워크스페이스 전환">
          <span className="ws-company-logo">
            <Icon name="logo" size={18} />
          </span>
          <span className="ws-company-meta">
            <span className="ws-company-name">리코더팩토리</span>
            <span className="ws-company-sub">워크스페이스</span>
          </span>
          <span className="ws-company-caret">
            <Icon name="chevronDown" size={14} />
          </span>
        </button>
        <button
          className="ws-icon-btn ws-head-actions"
          onClick={onToggleRail}
          title={collapseTitle}
          aria-label={collapseTitle}
        >
          <Icon name="sidebar" size={18} />
        </button>
      </div>

      <nav className="ws-nav">
        {/* 검색 / 대시보드 */}
        <Link href="/search" className={`ws-nav-item${pathname === "/search" ? " active" : ""}`} onClick={onNavigate} title="검색">
          <span className="ws-nav-ico"><Icon name="search" /></span>
          <span className="ws-nav-label">검색</span>
        </Link>
        <Link href="/dashboard" className={`ws-nav-item${pathname === "/dashboard" ? " active" : ""}`} onClick={onNavigate} title="대시보드">
          <span className="ws-nav-ico"><Icon name="dashboard" /></span>
          <span className="ws-nav-label">대시보드</span>
        </Link>
        <Link href="/inbox" className={`ws-nav-item${pathname === "/inbox" ? " active" : ""}`} onClick={onNavigate} title="알림">
          <span className="ws-nav-ico"><Icon name="inbox" /></span>
          <span className="ws-nav-label">알림</span>
          {unread > 0 && (
            <span style={{ marginLeft: "auto", minWidth: 18, height: 18, borderRadius: 9, background: "var(--color-primary)", color: "#fff", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px" }}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Link>

        {/* 프로젝트 (트리) */}
        <div className="ws-nav-section">
          <div className="ws-section-label">
            <Link href="/projects" onClick={onNavigate} title="모든 프로젝트" className="ws-section-link" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "inherit", textDecoration: "none" }}>
              <span>프로젝트</span>
              <span className="ws-nav-count">{projects.length}</span>
            </Link>
            <Link
              href="/projects"
              className="ws-icon-btn ws-section-add"
              onClick={onNavigate}
              title="새 프로젝트"
              aria-label="새 프로젝트"
              style={{ width: 22, height: 22, marginLeft: "auto" }}
            >
              <Icon name="plus" size={15} />
            </Link>
          </div>

          {groups.map((g) => {
            const open = !collapsed.has(g.key);
            const isDrop = dropKey === g.key;
            return (
              <div key={g.key} className="ws-doc-group">
                <div
                  className={`ws-tree-row ws-group-row${isDrop ? " drop-over" : ""}`}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    e.preventDefault();
                    if (dropKey !== g.key) setDropKey(g.key);
                  }}
                  onDragLeave={() => setDropKey((k) => (k === g.key ? null : k))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragId) void move(dragId, null, g.isProject ? g.key : null);
                    setDragId(null);
                    setDropKey(null);
                  }}
                >
                  <button className="ws-tree-twist" onClick={() => toggle(g.key)} aria-label={open ? "접기" : "펼치기"}>
                    <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
                  </button>
                  <span className="ws-tree-icon">{g.isProject ? "📁" : "🗄"}</span>
                  <button className="ws-tree-name ws-group-name" onClick={() => toggle(g.key)} title={g.name}>
                    {g.name}
                  </button>
                  {g.isProject && (
                    <span className="ws-row-actions">
                      <button className="ws-icon-btn ws-row-act" title="문서 추가" onClick={() => void createPage({ projectId: g.key })}>
                        <Icon name="plus" size={14} />
                      </button>
                      <button className="ws-icon-btn ws-row-act" title="폴더 추가" onClick={() => void createPage({ projectId: g.key, folder: true })}>
                        <Icon name="folder" size={14} />
                      </button>
                    </span>
                  )}
                </div>

                {open && (
                  <ul className="ws-tree">
                    {/* 보드 행 */}
                    {g.boards.map((b) => (
                      <li key={b.id}>
                        <div className={`ws-tree-row${activeId === b.id ? " active" : ""}`} style={{ paddingLeft: 20 }}>
                          <span className="ws-tree-twist" style={{ visibility: "hidden" }} />
                          <span className="ws-tree-icon"><Icon name="board" size={15} /></span>
                          <Link href={`/p/${b.id}?view=kanban`} className="ws-tree-name" onClick={onNavigate} title={b.title}>
                            {b.title || "태스크 보드"}
                          </Link>
                        </div>
                      </li>
                    ))}
                    {g.isProject && g.boards.length === 0 && (
                      <li>
                        <button className="ws-tree-row ws-tree-add" style={{ paddingLeft: 20 }} onClick={() => void createBoard(g.key)} disabled={busy}>
                          <span className="ws-tree-twist" style={{ visibility: "hidden" }} />
                          <span className="ws-tree-icon"><Icon name="board" size={15} /></span>
                          <span className="ws-tree-name" style={{ color: "var(--text-muted)" }}>태스크 보드 만들기</span>
                        </button>
                      </li>
                    )}
                    {/* 문서/폴더 트리 */}
                    {g.roots.map((n) => renderNode(n, g.key, 1))}
                    {g.boards.length === 0 && g.roots.length === 0 && !g.isProject && (
                      <li className="ws-tree-empty">비어 있음</li>
                    )}
                  </ul>
                )}
              </div>
            );
          })}
          {groups.length === 0 && loaded && <div className="ws-tree-empty">프로젝트가 없습니다</div>}
        </div>

        {/* 일반 */}
        <div className="ws-nav-section">
          <div className="ws-section-label"><span>일반</span></div>
          <Link href="/calendar" className={`ws-nav-item${pathname === "/calendar" ? " active" : ""}`} onClick={onNavigate} title="캘린더">
            <span className="ws-nav-ico"><Icon name="calendar" /></span>
            <span className="ws-nav-label">캘린더</span>
          </Link>
          <Link href="/sites" className={`ws-nav-item${pathname.startsWith("/sites") ? " active" : ""}`} onClick={onNavigate} title="퍼블리시">
            <span className="ws-nav-ico"><Icon name="link" /></span>
            <span className="ws-nav-label">퍼블리시</span>
          </Link>
          <Link href="/reminders" className={`ws-nav-item${pathname === "/reminders" ? " active" : ""}`} onClick={onNavigate} title="리마인더">
            <span className="ws-nav-ico"><Icon name="bell" /></span>
            <span className="ws-nav-label">리마인더</span>
          </Link>
          <Link href="/slack" className={`ws-nav-item${pathname === "/slack" ? " active" : ""}`} onClick={onNavigate} title="슬랙">
            <span className="ws-nav-ico"><Icon name="slack" /></span>
            <span className="ws-nav-label">슬랙</span>
          </Link>
          <Link href="/approvals" className={`ws-nav-item${pathname === "/approvals" ? " active" : ""}`} onClick={onNavigate} title="승인">
            <span className="ws-nav-ico"><Icon name="inbox" /></span>
            <span className="ws-nav-label">승인</span>
          </Link>
          <Link href="/aiconnect" className={`ws-nav-item${pathname === "/aiconnect" ? " active" : ""}`} onClick={onNavigate} title="AI 연결">
            <span className="ws-nav-ico"><Icon name="logo" /></span>
            <span className="ws-nav-label">AI 연결</span>
          </Link>
        </div>

        {/* 관리 */}
        <div className="ws-nav-section">
          <div className="ws-section-label"><span>관리</span></div>
          <Link href="/members" className={`ws-nav-item${pathname === "/members" ? " active" : ""}`} onClick={onNavigate} title="멤버">
            <span className="ws-nav-ico"><Icon name="users" /></span>
            <span className="ws-nav-label">멤버</span>
          </Link>
          <Link href="/settings" className={`ws-nav-item${pathname === "/settings" ? " active" : ""}`} onClick={onNavigate} title="설정">
            <span className="ws-nav-ico"><Icon name="settings" /></span>
            <span className="ws-nav-label">설정</span>
          </Link>
        </div>
      </nav>

      {/* 컨텍스트 메뉴 */}
      {menu && (
        <div className="ws-ctx-menu" style={{ top: menu.y, left: Math.max(8, menu.x - 180) }} onClick={(e) => e.stopPropagation()}>
          <button className="ws-ctx-item" onClick={() => { setRenaming(menu.node.id); setDraft(menu.node.title); setMenu(null); }}>
            이름 변경
          </button>
          <button className="ws-ctx-item" onClick={() => { void createPage({ parentId: menu.node.id, projectId: menu.node.projectId }); setMenu(null); }}>
            문서 추가
          </button>
          <button className="ws-ctx-item" onClick={() => { void createPage({ parentId: menu.node.id, projectId: menu.node.projectId, folder: true }); setMenu(null); }}>
            폴더 추가
          </button>
          <div className="ws-ctx-sep" />
          <button className="ws-ctx-item danger" onClick={() => { void remove({ id: menu.node.id, title: menu.node.title, hasChildren: menu.hasChildren }); setMenu(null); }}>
            삭제
          </button>
        </div>
      )}

      {/* 하단 사용자 카드 + 테마 토글 */}
      <div className="ws-side-foot">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button className="ws-user-card" title="계정">
            {sessionUser?.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="ds-avatar" src={sessionUser.image} alt={userName} style={{ width: 30, height: 30, objectFit: "cover" }} />
            ) : (
              <span className="ds-avatar" style={{ width: 30, height: 30, background: "var(--ds-primary)", color: "#fff", fontSize: 12 }}>
                {userInitials}
              </span>
            )}
            <span className="ws-user-meta">
              <span className="ws-user-name">{userName}</span>
              <span className="ws-user-sub">{userEmail}</span>
            </span>
          </button>
          {sessionUser && (
            <button className="ws-icon-btn" onClick={() => void signOut({ redirectTo: "/login" })} title="로그아웃" aria-label="로그아웃">
              <Icon name="logout" size={18} />
            </button>
          )}
          <button className="ws-icon-btn" onClick={onToggleTheme} title={theme === "dark" ? "라이트 모드" : "다크 모드"} aria-label="테마 전환">
            <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
}

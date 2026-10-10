"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Icon } from "./ws/icons";
import type { InitialSidebar, SessionUser } from "./AppShell";
import { useSidebarData } from "./sidebar/useSidebarData";
import { SidebarQuick } from "./sidebar/SidebarQuick";
import { SidebarTree, type CreatePageOpts } from "./sidebar/SidebarTree";
import { DUPLICATE_RENAME_NOTICE, renameCollides } from "@/lib/renameDuplicate";

type Theme = "light" | "dark";

export default function Sidebar({
  rail,
  theme,
  onToggleRail,
  onToggleTheme,
  onNavigate,
  sessionUser = null,
  initialSidebar = null,
}: {
  rail: boolean;
  theme: Theme;
  onToggleRail: () => void;
  onToggleTheme: () => void;
  onNavigate?: () => void;
  sessionUser?: SessionUser;
  initialSidebar?: InitialSidebar;
}) {
  const [busy, setBusy] = useState(false);
  // 이름 바꾸기 뒤 같은 제목 경고(비차단, 몇 초 뒤 사라진다)
  const [dupNotice, setDupNotice] = useState(false);
  const [unread, setUnread] = useState(0);
  const pathname = usePathname();
  const router = useRouter();

  const activeId = pathname.startsWith("/p/") ? pathname.slice(3) : null;
  const data = useSidebarData(activeId, initialSidebar);
  const { refresh } = data;

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


  // ── 변이(mutation) ──
  const createPage = useCallback(
    async (opts: CreatePageOpts): Promise<string | null> => {
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
        if (!res.ok) return null;
        const { page } = (await res.json()) as { page: { id: string } };
        await refresh();
        if (!opts.folder) {
          router.push(`/p/${page.id}`);
          onNavigate?.();
        }
        return page.id;
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
      if (!t) return;
      const res = await fetch(`/api/pages/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: t }),
      });
      await refresh();
      if (res.ok && (await renameCollides(id))) setDupNotice(true);
    },
    [refresh],
  );

  useEffect(() => {
    if (!dupNotice) return;
    const t = setTimeout(() => setDupNotice(false), 6000);
    return () => clearTimeout(t);
  }, [dupNotice]);

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

  const collapseTitle = rail ? "사이드바 펼치기" : "사이드바 접기";
  const userName = sessionUser ? sessionUser.name ?? sessionUser.email ?? "사용자" : "이호준";
  const userEmail = sessionUser ? sessionUser.email ?? "" : "you@example.com";
  const userInitials = userName.slice(0, 2);

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

        <SidebarQuick favorites={data.favorites} recents={data.recents} activeId={activeId} onNavigate={onNavigate} />

        {dupNotice && (
          <div role="status" style={{ margin: "6px 10px", padding: "6px 10px", borderRadius: 8, fontSize: 12, color: "#E0900F", border: "1px solid #E0900F", background: "var(--surface-sunken)" }}>
            {DUPLICATE_RENAME_NOTICE}
          </div>
        )}

        {/* 프로젝트 (트리) */}
        <SidebarTree
          groups={data.groups}
          collapsed={data.collapsed}
          ready={data.ready}
          toggle={data.toggle}
          activeId={activeId}
          onNavigate={onNavigate}
          createPage={createPage}
          createBoard={createBoard}
          busy={busy}
          loaded={data.loaded}
          move={move}
          rename={rename}
          remove={remove}
          toggleFavorite={data.toggleFavorite}
          setDocType={data.setDocType}
        />

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

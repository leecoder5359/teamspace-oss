"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import dynamic from "next/dynamic";

// 전역 단축키(Cmd/Ctrl+K)라 어느 화면에서든 살아 있어야 한다. window 를 쓰므로
// 클라이언트 전용 로드 — 첫 페인트를 막지 않게 지연 로드한다.
const CommandPalette = dynamic(() => import("./CommandPalette"), { ssr: false });
import { Icon } from "./ws/icons";
import type { SidebarPage, SidebarProject } from "@/lib/pagesList";
import { seedPages } from "@/lib/pagesClient";

type Theme = "light" | "dark";

export type SessionUser = {
  name: string | null;
  email: string | null;
  image: string | null;
} | null;

/** 레이아웃이 서버에서 읽어 넘기는 첫 사이드바 트리(U7). null = 서버 조회 실패 → 클라가 받는다. */
export type InitialSidebar = { pages: SidebarPage[]; projects: SidebarProject[]; serverTime?: string } | null;

export default function AppShell({
  children,
  sessionUser = null,
  initialSidebar = null,
}: {
  children: React.ReactNode;
  sessionUser?: SessionUser;
  initialSidebar?: InitialSidebar;
}) {
  // 서버가 준 목록을 자식이 렌더되기 전에 공유 캐시에 심는다 — 사이드바가 마운트되기 전에 getPages() 를 부르는
  // 페이지 컴포넌트도 네트워크 없이 받는다. 마운트당 한 번: useState 초기화 함수가 그 가드다(렌더 중 ref 쓰기는
  // react-hooks/refs 가 막는다). 서버에서는 seedPages 가 아무것도 안 한다.
  // 사이드바 훅도 같은 목록을 심지만 seedPages 가 더 새 캐시·이후 무효화를 이기지 못하게 막는다.
  useState(() => {
    if (initialSidebar) seedPages({ pages: initialSidebar.pages }, { at: initialSidebar.serverTime });
    return true;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rail, setRail] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");

  // 마운트 시 현재 적용된 테마(레이아웃 인라인 스크립트가 설정)를 읽어온다.
  useEffect(() => {
    const current = (document.documentElement.dataset.theme as Theme) || "light";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current);
    try {
      setRail(localStorage.getItem("ws-rail") === "1");
    } catch {}
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("ws-theme", next);
      } catch {}
      return next;
    });
  }, []);

  const toggleRail = useCallback(() => {
    setRail((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("ws-rail", next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  return (
    <div
      className={`ws-shell${rail ? " rail" : ""}${drawerOpen ? " drawer-open" : ""}`}
    >
      <button
        className="ws-hamburger"
        onClick={() => setDrawerOpen(true)}
        aria-label="메뉴 열기"
      >
        <Icon name="menu" size={20} />
      </button>

      {drawerOpen && <div className="ws-backdrop" onClick={closeDrawer} />}

      <Suspense fallback={<aside className="ws-sidebar" />}>
        <Sidebar
          rail={rail}
          theme={theme}
          onToggleRail={toggleRail}
          onToggleTheme={toggleTheme}
          onNavigate={closeDrawer}
          sessionUser={sessionUser}
          initialSidebar={initialSidebar}
        />
      </Suspense>

      <main className="ws-main">{children}</main>

      <CommandPalette />
    </div>
  );
}

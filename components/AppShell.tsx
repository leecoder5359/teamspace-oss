"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Sidebar from "./Sidebar";
import { Icon } from "./ws/icons";

type Theme = "light" | "dark";

export type SessionUser = {
  name: string | null;
  email: string | null;
  image: string | null;
} | null;

export default function AppShell({
  children,
  sessionUser = null,
}: {
  children: React.ReactNode;
  sessionUser?: SessionUser;
}) {
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
        />
      </Suspense>

      <main className="ws-main">{children}</main>
    </div>
  );
}

"use client";
import Link from "next/link";
import { docTypeIcon } from "@/lib/docOrganize";
import type { QuickItem } from "./useSidebarData";

function Row({ item, active, onNavigate }: { item: QuickItem; active: boolean; onNavigate?: () => void }) {
  return (
    <li>
      <Link href={`/p/${item.pageId}`} className={`ws-tree-row ws-quick-row${active ? " active" : ""}`} onClick={onNavigate} title={item.title}>
        <span className="ws-tree-icon">{item.kind === "database" ? "📋" : docTypeIcon(item.docType)}</span>
        <span className="ws-tree-title">{item.title}</span>
      </Link>
    </li>
  );
}

export function SidebarQuick({ favorites, recents, activeId, onNavigate }: { favorites: QuickItem[]; recents: QuickItem[]; activeId: string | null; onNavigate?: () => void }) {
  const recentShown = recents.filter((r) => r.pageId !== activeId).slice(0, 8);
  return (
    <>
      <div className="ws-nav-section ws-quick">
        <div className="ws-section-label"><span>⭐ 즐겨찾기</span></div>
        {favorites.length === 0 ? (
          <div className="ws-quick-empty">문서 우클릭 → ★ 로 고정하세요</div>
        ) : (
          <ul className="ws-tree">{favorites.map((f) => <Row key={f.pageId} item={f} active={f.pageId === activeId} onNavigate={onNavigate} />)}</ul>
        )}
      </div>
      {recentShown.length > 0 && (
        <div className="ws-nav-section ws-quick">
          <div className="ws-section-label"><span>🕘 최근</span></div>
          <ul className="ws-tree">{recentShown.map((r) => <Row key={r.pageId} item={r} active={false} onNavigate={onNavigate} />)}</ul>
        </div>
      )}
    </>
  );
}

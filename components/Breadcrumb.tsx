"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { pathOf } from "@/lib/pagesMeta";
import { getPages } from "@/lib/pagesClient";
import { getProjects } from "@/lib/projectsClient";
import { recordVisit } from "@/lib/visitsClient";

type Item = { id: string | null; label: string; href: string };

export default function Breadcrumb({ pageId }: { pageId: string }) {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => {
    let alive = true;
    // 방문 기록 — pageId 당 1회, 실패는 무시(성공하면 visits:changed 로 사이드바 '최근' 이 다시 읽는다)
    void recordVisit(pageId);
    (async () => {
      try {
        // 둘 다 공유 캐시 — 사이드바가 같은 목록을 받거나 서버가 심어 둔 값이 있으면 네트워크를 다시 타지 않는다.
        const [p, projects] = await Promise.all([
          getPages(),
          getProjects() /* 보관 프로젝트 문서도 경로가 보이게(F10) */,
        ]);
        if (!p.ok || !projects) return;
        const pages = (p.data as { pages: { id: string; title: string; parentId: string | null; projectId: string | null }[] }).pages;
        if (alive) setItems(pathOf(pages, projects, pageId));
      } catch {
        /* 경로 표시는 부가 기능 — 실패해도 페이지는 그대로 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [pageId]);
  if (items.length < 2) return null;
  return (
    <nav className="ws-breadcrumb" aria-label="문서 경로">
      {items.map((it, i) => (
        <span key={it.id ?? "proj"}>
          {i > 0 && <span className="ws-breadcrumb-sep">›</span>}
          {i === items.length - 1 ? <span className="ws-breadcrumb-cur">{it.label}</span> : <Link href={it.href}>{it.label}</Link>}
        </span>
      ))}
    </nav>
  );
}

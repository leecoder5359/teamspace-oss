"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocType } from "@/lib/docOrganize";
import { getPages, seedPages } from "@/lib/pagesClient";
import { groupByProject, resolveCollapsed, taskNoteFolderIds, type FlatPage, type Group } from "./treeModel";

export type QuickItem = { pageId: string; title: string; kind: "doc" | "database"; docType: DocType | null; projectId: string | null };
// v2: 폴더 구조 개편과 함께 기본 접힘(현재 프로젝트만 펼침)을 모두에게 한 번 적용한다.
const LS_COLLAPSED = "ws-sidebar-collapsed:v2";
// 이미 본 '태스크 설명' 폴더 id — 처음 보는 폴더만 접어 두고, 사용자가 펼친 건 다시 접지 않는다.
const LS_SEEN = "ws-sidebar-seen:v2";

/** (ws) 레이아웃이 서버에서 읽어 넘기는 첫 트리(U7). null = 서버 조회 실패 → 클라 fetch 로. */
export type SidebarInitial = {
  pages: FlatPage[];
  projects: { id: string; name: string; archived?: boolean }[];
  /** 서버가 목록을 읽은 시각(ISO) — 공유 캐시 TTL 의 기준. */
  serverTime?: string;
} | null;

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * 사이드바 데이터. 현재 프로젝트는 훅이 가진 flat 에서 바로 구한다 —
 * 호출부가 flat 으로 프로젝트를 구해 다시 넘기면 첫 로드 때 한 박자 늦은 null 로 기본 접힘이 정해진다.
 */
export function useSidebarData(activePageId: string | null, initial?: SidebarInitial) {
  // 클라 페이지 캐시만으로 미리 채우지 않는다 — 프로젝트 목록이 비어 있는 첫 렌더에서 전부 '미분류'로 묶이고
  // 기본 접힘 effect 가 그 틀린 그룹으로 접힘 기본값을 저장해 버린다. 페이지·프로젝트를 함께 받은 뒤 채운다.
  // 서버 주입(initial)은 둘을 함께 주므로 첫 렌더부터 쓴다 — 서버·클라 첫 렌더가 같은 값이라 하이드레이션도 맞다.
  const [flat, setFlat] = useState<FlatPage[]>(() => initial?.pages ?? []);
  const [projects, setProjects] = useState<{ id: string; name: string; archived?: boolean }[]>(() => initial?.projects ?? []);
  const [favorites, setFavorites] = useState<QuickItem[]>([]);
  const [recents, setRecents] = useState<QuickItem[]>([]);
  const [loaded, setLoaded] = useState(() => Boolean(initial));
  // 마운트 때 한 번만 공유 캐시에 심는다 — 이후 레이아웃이 다시 렌더돼 prop 이 바뀌어도 상태는 훅이 관리한다.
  const seedRef = useRef(initial ? { pages: initial.pages, at: initial.serverTime } : null);
  // 접힘 상태. null = 아직 결정 전(그룹 머리만 그린다).
  // 서버 주입(initial)이 있으면 서버가 알 수 있는 기본값(저장값 없음 = 현재 프로젝트만 펼침)으로 시작한다 —
  // 서버·클라 첫 렌더가 같은 트리를 그리고, 저장값이 없는 사용자는 마운트 뒤에도 뒤집히지 않는다.
  // 저장값(localStorage)은 서버가 모르므로 그런 사용자만 마운트 effect 에서 한 번 바뀐다(감수한 트레이드오프).
  const [collapsed, setCollapsed] = useState<Set<string> | null>(() => {
    if (!initial) return null;
    const groups0 = groupByProject(initial.pages, initial.projects);
    if (groups0.length === 0) return null;
    const active0 = activePageId ? (initial.pages.find((x) => x.id === activePageId)?.projectId ?? null) : null;
    return resolveCollapsed(null, null, groups0, active0).collapsed;
  });
  const persist = useRef(false);
  const seenRef = useRef<Set<string> | null>(null);
  // localStorage 의 저장값을 읽어 반영했나 — 서버 기본값으로 시작했어도 마운트 때 한 번은 읽어야 한다.
  const restoredRef = useRef(false);

  // 기본은 fresh — 쓰기 직후(토글·docType·refresh)에 낡은 캐시를 읽지 않게. 첫 마운트만 공유 캐시를 쓴다.
  const reload = useCallback(async (opts: { fresh?: boolean } = {}) => {
    const [p, pj, f, v] = await Promise.all([
      getPages({ fresh: opts.fresh ?? true }), fetch("/api/projects?archived=all", { cache: "no-store" }), // 보관 프로젝트도 받아 (보관) 그룹으로 남긴다(F10)
      fetch("/api/favorites", { cache: "no-store" }), fetch("/api/visits?limit=9", { cache: "no-store" }),
    ]);
    // 본문을 모두 읽은 뒤 한꺼번에 반영한다 — 사이에 렌더가 끼면 프로젝트 없이 그룹이 잡혀 기본 접힘이 틀어진다.
    const pages = p.ok ? (p.data as { pages: FlatPage[] }).pages : null;
    const pjs = pj.ok ? ((await pj.json()) as { projects: { id: string; name: string; archivedAt?: string | null }[] }).projects.map(({ id, name, archivedAt }) => ({ id, name, archived: archivedAt != null })) : null;
    const favs = f.ok ? ((await f.json()) as { favorites: QuickItem[] }).favorites : null;
    const vis = v.ok ? ((await v.json()) as { visits: QuickItem[] }).visits : null;
    if (pages) setFlat(pages);
    if (pjs) setProjects(pjs);
    if (favs) setFavorites(favs);
    if (vis) setRecents(vis);
    if (pages) setLoaded(true);
  }, []);

  // pages:changed 로 시작된 reload — Sidebar.refresh 가 같은 요청을 기다리게 해 fresh 를 두 번 부르지 않는다.
  const pendingRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const on = () => {
      pendingRef.current = reload().catch(() => undefined);
    };
    const first = () => void reload({ fresh: false });
    // 서버가 준 목록을 캐시에 먼저 심어 첫 reload 가 /api/pages 를 다시 받지 않게 한다(U7).
    if (seedRef.current) {
      seedPages({ pages: seedRef.current.pages }, { at: seedRef.current.at });
      seedRef.current = null;
    }
    first();
    window.addEventListener("pages:changed", on);
    return () => window.removeEventListener("pages:changed", on);
  }, [reload]);

  // 문서를 열면 Breadcrumb 이 방문을 기록하고 visits:changed 를 쏜다 — 최근만 다시 읽는다.
  useEffect(() => {
    const on = async () => {
      const v = await fetch("/api/visits?limit=9", { cache: "no-store" }).catch(() => null);
      if (v?.ok) setRecents(((await v.json()) as { visits: QuickItem[] }).visits);
    };
    const handler = () => void on();
    window.addEventListener("visits:changed", handler);
    return () => window.removeEventListener("visits:changed", handler);
  }, []);

  const groups = useMemo<Group[]>(() => groupByProject(flat, projects), [flat, projects]);
  const activeProjectId = useMemo(
    () => (activePageId ? (flat.find((x) => x.id === activePageId)?.projectId ?? null) : null),
    [flat, activePageId],
  );

  // 접힘 상태: 저장된 것이 있으면 그것, 없으면 현재 프로젝트만 펼침(최초 1회).
  // 처음 보는 '태스크 설명' 폴더는(로드 중 새로 생긴 것 포함) 한 번 접어 둔다.
  useEffect(() => {
    if (groups.length === 0) return;
    if (restoredRef.current && taskNoteFolderIds(groups).every((id) => seenRef.current?.has(id))) return;
    let saved: string[] | null = null;
    let seen: string[] | null = null;
    if (!restoredRef.current) {
      const read = (k: string) => { try { const raw = localStorage.getItem(k); return raw ? (JSON.parse(raw) as string[]) : null; } catch { return null; } };
      saved = read(LS_COLLAPSED);
      seen = read(LS_SEEN);
    } else {
      saved = [...(collapsed ?? [])];
      seen = [...(seenRef.current ?? [])];
    }
    const next = resolveCollapsed(saved, seen, groups, activeProjectId);
    restoredRef.current = true;
    seenRef.current = new Set(next.seen);
    try { localStorage.setItem(LS_SEEN, JSON.stringify(next.seen)); } catch { /* 저장 불가 환경 */ }
    persist.current = true;
    if (collapsed && sameSet(collapsed, next.collapsed)) {
      // 서버 기본값과 같다 — 다시 렌더하지 않고(뒤집힘 없음) 최초 기본값만 저장해 둔다.
      try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...next.collapsed])); } catch { /* 저장 불가 환경 */ }
      return;
    }
    setCollapsed(next.collapsed);
  }, [groups, collapsed, activeProjectId]);

  useEffect(() => {
    if (!persist.current || collapsed === null) return;
    try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...collapsed])); } catch { /* 저장 불가 환경 */ }
  }, [collapsed]);

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => { const n = new Set(prev ?? []); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  }, []);

  const toggleFavorite = useCallback(async (pageId: string) => {
    const isFav = favorites.some((f) => f.pageId === pageId);
    await fetch(isFav ? `/api/favorites?pageId=${encodeURIComponent(pageId)}` : "/api/favorites", isFav ? { method: "DELETE" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pageId }) });
    await reload();
  }, [favorites, reload]);

  const setDocType = useCallback(async (pageId: string, t: DocType | null) => {
    await fetch(`/api/pages/${pageId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ docType: t }) });
    await reload();
  }, [reload]);

  /** 변이 직후 새로고침: pages:changed 를 쏴 다른 구독자를 무효화하고, 이 훅의 리스너가 시작한 reload 하나만 기다린다(fresh 1회). */
  const refresh = useCallback(async () => {
    pendingRef.current = null;
    window.dispatchEvent(new Event("pages:changed"));
    await (pendingRef.current ?? reload());
  }, [reload]);

  return { flat, projects, groups, favorites, recents, loaded, activeProjectId, collapsed: collapsed ?? new Set<string>(), ready: collapsed !== null, toggle, reload, refresh, toggleFavorite, setDocType };
}

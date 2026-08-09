"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "./ws/icons";
import { NAV_COMMANDS, rankItems, moveCursor, type PaletteItem } from "@/lib/palette";

/* =====================================================================
   커맨드 팔레트 (Cmd/Ctrl+K) — 격차 F3·F4.

   전역 단축키 핸들러가 이 저장소에 한 곳도 없었다. 옵시디언 Ctrl+P·노션 Cmd+K 는
   부가 기능이 아니라 **주 이동 수단**인데, 문서가 400개를 넘은 워크스페이스에서
   사이드바 클릭만으로는 감당이 안 된다. 빠른 전환(F4)도 같은 뿌리라 함께 닫는다.

   후보는 열 때 한 번만 받아온다 — 타이핑마다 서버를 때리면 느리고, 이 규모(수백
   건)는 클라이언트에서 거르는 게 훨씬 빠르다. 매칭·랭킹은 lib/palette 가 한다.
   ===================================================================== */

const KIND_META: Record<PaletteItem["kind"], { icon: IconName; label: string }> = {
  command: { icon: "board", label: "이동" },
  doc: { icon: "doc", label: "문서" },
  board: { icon: "table", label: "보드" },
  project: { icon: "folder", label: "프로젝트" },
  task: { icon: "check", label: "태스크" },
};

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [pages, setPages] = useState<PaletteItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /** 열고 닫을 때 질의·커서를 함께 정리한다 — 상태가 한 곳에서만 바뀐다. */
  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    setQuery("");
    setCursor(0);
  }, []);

  /* ── 전역 단축키 ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => {
          // 열 때만 초기화 — 닫을 때는 굳이 렌더를 더 만들지 않는다
          if (!v) {
            setQuery("");
            setCursor(0);
          }
          return !v;
        });
        return;
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ── 열릴 때 후보 적재(한 번만) ── */
  useEffect(() => {
    if (!open || loaded) return;
    let alive = true;
    (async () => {
      const res = await fetch("/api/pages", { cache: "no-store" }).catch(() => null);
      if (!res?.ok || !alive) return;
      const d = (await res.json()) as {
        pages: { id: string; title: string; kind: string; project?: { name?: string } | null }[];
      };
      if (!alive) return;
      setPages(
        d.pages.map((p) => ({
          id: `p:${p.id}`,
          kind: p.kind === "database" ? ("board" as const) : ("doc" as const),
          title: p.title,
          hint: p.project?.name ?? undefined,
          href: `/p/${p.id}`,
        })),
      );
      setLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, [open, loaded]);

  /* ── 열릴 때 입력에 포커스 ──
     질의·커서 초기화는 여는/닫는 지점(toggle)에서 직접 한다. effect 안에서
     setState 하면 연쇄 렌더가 되고 린트도 막는다. */
  useEffect(() => {
    if (!open) return;
    // 렌더 직후에 줘야 모달이 실제로 붙은 뒤에 포커스가 잡힌다
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const results = useMemo(() => rankItems([...NAV_COMMANDS, ...pages], query), [pages, query]);

  const go = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item?.href) return;
      setOpenState(false);
      router.push(item.href);
    },
    [router, setOpenState],
  );

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => moveCursor(c, 1, results.length));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => moveCursor(c, -1, results.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[cursor]?.item);
    }
  };

  // 커서가 화면 밖으로 나가면 따라 스크롤한다
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, results.length]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="커맨드 팔레트"
      onClick={() => setOpenState(false)}
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "var(--overlay-scrim, rgba(25,31,40,.42))",
        display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(620px, 92vw)", background: "var(--surface-card)",
          border: "1px solid var(--border-subtle)", borderRadius: 14,
          boxShadow: "0 20px 60px rgba(0,0,0,.35)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderBottom: "1px solid var(--border-subtle)" }}>
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKey}
            placeholder="문서·보드로 이동하거나 화면을 여세요"
            aria-label="검색어"
            style={{
              flex: 1, background: "none", border: "none", outline: "none",
              color: "var(--text-strong)", fontSize: 15, fontFamily: "inherit",
            }}
          />
          <kbd style={{ fontSize: 11, color: "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: 5, padding: "1px 5px" }}>
            esc
          </kbd>
        </div>

        <div ref={listRef} style={{ maxHeight: "52vh", overflowY: "auto", padding: 6 }}>
          {results.length === 0 && (
            <div style={{ padding: "20px 12px", color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
              {loaded ? "일치하는 항목이 없습니다." : "불러오는 중…"}
            </div>
          )}
          {results.map((r, i) => {
            const meta = KIND_META[r.item.kind];
            const active = i === cursor;
            return (
              <button
                key={r.item.id}
                data-active={active}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(r.item)}
                style={{
                  display: "flex", alignItems: "center", gap: 10, width: "100%",
                  padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
                  background: active ? "var(--surface-hover)" : "transparent",
                  color: "var(--text-body)", font: "inherit", textAlign: "left",
                }}
              >
                <Icon name={meta.icon} size={15} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.item.title}
                </span>
                {r.item.hint && (
                  <span style={{ fontSize: 11.5, color: "var(--text-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.item.hint}
                  </span>
                )}
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", border: "1px solid var(--border-subtle)", borderRadius: 5, padding: "1px 6px" }}>
                  {meta.label}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 12, padding: "7px 14px", borderTop: "1px solid var(--border-subtle)", fontSize: 11, color: "var(--text-muted)" }}>
          <span>↑↓ 이동</span>
          <span>⏎ 열기</span>
          <span>esc 닫기</span>
          <span style={{ marginLeft: "auto" }}>{results.length}건</span>
        </div>
      </div>
    </div>
  );
}

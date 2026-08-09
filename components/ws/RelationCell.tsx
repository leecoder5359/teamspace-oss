"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";
import { normalizeIds, toggleId, relationLabel, sameIds } from "@/lib/relation";

/* =====================================================================
   relation 셀 (격차 C2) — 다른 보드의 행을 골라 잇는다.

   값은 대상 보드의 **행 id 배열**이다. 화면에는 제목으로 보여야 의미가 있으므로
   호출자가 `options`(대상 보드의 {id,title})를 넘겨준다.

   제목을 못 찾은 id 는 지우지 않고 **"(삭제된 행)"** 으로 남긴다 — 조용히 빼면
   연결이 사라진 걸 아무도 모른 채 데이터만 어긋난다.
   ===================================================================== */

export type RelationOption = { id: string; title: string };

export default function RelationCell({
  value,
  options,
  onChange,
  disabled,
}: {
  value: unknown;
  options: RelationOption[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const ids = useMemo(() => normalizeIds(value), [value]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // 표 셀은 overflow 로 잘린다 — 드롭다운을 body 로 띄우고 위치만 버튼에 맞춘다.
  // (셀 안에 두면 후보가 한 줄만 보이는 채로 '목록이 비었다'로 오해된다.)
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const titleOf = useMemo(() => {
    const m = new Map(options.map((o) => [o.id, o.title]));
    return (id: string) => m.get(id) ?? null;
  }, [options]);

  const { shown, overflow } = relationLabel(ids, titleOf, 2);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = needle ? options.filter((o) => o.title.toLowerCase().includes(needle)) : options;
    return base.slice(0, 50); // 긴 보드에서 목록이 무한정 길어지지 않게
  }, [options, q]);

  function commit(next: string[]) {
    if (!sameIds(next, ids)) onChange(next);
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        className="ws-cell-input"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: disabled ? "default" : "pointer",
          flexWrap: "wrap",
          minHeight: 24,
        }}
      >
        {shown.length === 0 && <span style={{ color: "var(--text-disabled)" }}>—</span>}
        {shown.map((t, i) => (
          <span
            key={`${t}-${i}`}
            style={{
              fontSize: 11.5,
              padding: "1px 7px",
              borderRadius: 999,
              border: "1px solid var(--border-subtle)",
              background: "var(--surface-sunken)",
              whiteSpace: "nowrap",
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: t === "(삭제된 행)" ? "var(--text-disabled)" : undefined,
            }}
          >
            {t}
          </span>
        ))}
        {overflow > 0 && <span style={{ fontSize: 11.5, color: "var(--text-disabled)" }}>+{overflow}</span>}
      </button>

      {open && !disabled && pos && createPortal(
        <div
          style={{
            position: "fixed",
            zIndex: 60,
            top: pos.top,
            left: pos.left,
            minWidth: Math.max(260, pos.width),
            maxHeight: 300,
            overflowY: "auto",
            background: "var(--surface-card)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 10,
            boxShadow: "0 8px 24px rgba(0,0,0,.25)",
            padding: 8,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
            <Icon name="search" size={13} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="행 검색…"
              style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontSize: 13, color: "var(--text-body)" }}
            />
            <button className="ws-btn-soft" style={{ padding: "2px 6px" }} onClick={() => setOpen(false)}>
              닫기
            </button>
          </div>

          {filtered.length === 0 && <div className="ws-empty-hint">해당하는 행이 없습니다.</div>}
          {filtered.map((o) => {
            const on = ids.includes(o.id);
            return (
              <button
                key={o.id}
                onClick={() => commit(toggleId(ids, o.id))}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  textAlign: "left",
                  padding: "5px 6px",
                  borderRadius: 6,
                  border: "none",
                  background: on ? "var(--surface-sunken)" : "transparent",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--text-body)",
                }}
              >
                <Icon name={on ? "check" : "circle"} size={13} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.title}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

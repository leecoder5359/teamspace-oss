"use client";

import type { ReactNode } from "react";
import type { FilterGroup } from "@/lib/dbFilter";
import type { PillMode } from "../ws/ui";
import FilterPanel from "./FilterPanel";
import type { DbProperty, DbView } from "./useBoardData";

export type Density = "compact" | "cozy" | "roomy";

/* ===== 보드 툴바 (T-4b — DatabaseView 에서 분리) =====
   검색·빠른 select 필터·열린 것만·초기화·복합 필터·메타 열·밀도/색상 모드.
   상태는 모두 화면(DatabaseView)이 들고 있고 여기는 그리기만 한다 — props 만 받는다. */
export default function ViewToolbar<K extends string>({
  query,
  onQueryChange,
  selectProps,
  quickFilters,
  onQuickFilterChange,
  showOpenOnly,
  openOnly,
  onOpenOnlyChange,
  closedHidden,
  shownCount,
  totalCount,
  onClear,
  properties,
  filter,
  onFilterChange,
  viewType,
  metaColumns,
  meta,
  onMetaChange,
  presence,
  colorMode,
  onColorModeChange,
  density,
  onDensityChange,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  /** 빠른 필터 드롭다운을 낼 select 속성 */
  selectProps: DbProperty[];
  /** propId → 옵션 id("" = 전체) */
  quickFilters: Record<string, string>;
  onQuickFilterChange: (propId: string, optionId: string) => void;
  /** 표 뷰 + 상태 속성이 있을 때만 "열린 것만" 토글을 낸다 */
  showOpenOnly: boolean;
  openOnly: boolean;
  onOpenOnlyChange: (on: boolean) => void;
  closedHidden: number;
  /** 초기화 (n/m) — n = 지금 보이는 행, m = 전체 행 */
  shownCount: number;
  totalCount: number;
  onClear: () => void;
  properties: DbProperty[];
  filter: FilterGroup | null;
  onFilterChange: (next: FilterGroup | null) => void;
  viewType: DbView["type"] | undefined;
  metaColumns: readonly { key: K; label: string }[];
  meta: K[];
  onMetaChange: (next: K[]) => void;
  /** 접속자 표시(PresenceBar) 자리 */
  presence?: ReactNode;
  colorMode: PillMode;
  onColorModeChange: (m: PillMode) => void;
  density: Density;
  onDensityChange: (d: Density) => void;
}) {
  return (
    <div className="ws-db-toolbar">
      <input
        className="ws-db-search"
        type="search"
        placeholder="검색…"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
      />
      {selectProps.map((p) => (
        <select
          key={p.id}
          className="ws-db-filter"
          value={quickFilters[p.id] ?? ""}
          onChange={(e) => onQuickFilterChange(p.id, e.target.value)}
        >
          <option value="">{p.name}: 전체</option>
          {(p.config?.options ?? []).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      ))}
      {showOpenOnly && (
        <label
          className="ws-db-filter"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}
          title="완료·취소 상태의 행을 숨깁니다(이 브라우저에만 저장)"
        >
          <input type="checkbox" checked={openOnly} onChange={(e) => onOpenOnlyChange(e.target.checked)} />
          열린 것만
          {openOnly && closedHidden > 0 && (
            <span style={{ color: "var(--text-muted)" }}>완료·취소 {closedHidden}건 숨김</span>
          )}
        </label>
      )}
      {(query || Object.values(quickFilters).some(Boolean) || !!filter?.rules.length) && (
        <button className="ws-db-clear" onClick={onClear}>
          초기화 ({shownCount}/{totalCount})
        </button>
      )}

      <FilterPanel properties={properties} filter={filter} onChange={onFilterChange} />

      {viewType !== "kanban" && (
        <details className="ws-meta-toggle" style={{ position: "relative" }}>
          <summary
            className="ws-db-filter"
            style={{ cursor: "pointer", listStyle: "none", userSelect: "none" }}
            title="만든/수정 시각·사람 열 — 데이터는 원래 저장돼 있었는데 보여줄 곳이 없었다"
          >
            메타 열{meta.length > 0 ? ` ${meta.length}` : ""}
          </summary>
          <div
            style={{
              position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, minWidth: 160,
              background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
              borderRadius: 10, padding: 8, boxShadow: "var(--shadow-md, 0 6px 20px rgba(0,0,0,.12))",
            }}
          >
            {metaColumns.map((c) => {
              const cur = meta;
              const on = cur.includes(c.key);
              return (
                <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 2px", fontSize: 12.5, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      onMetaChange(on ? cur.filter((x) => x !== c.key) : [...cur, c.key])
                    }
                  />
                  {c.label}
                </label>
              );
            })}
          </div>
        </details>
      )}

      {presence}
      <span className="ws-toolbar-spacer" />

      {viewType === "kanban" && (
        <div className="ws-seg" role="group" aria-label="카드 색상 모드">
          {(["soft", "solid", "bar"] as PillMode[]).map((m) => (
            <button
              key={m}
              className={`ws-seg-btn${colorMode === m ? " active" : ""}`}
              onClick={() => onColorModeChange(m)}
            >
              {m === "soft" ? "소프트" : m === "solid" ? "솔리드" : "바"}
            </button>
          ))}
        </div>
      )}

      <div className="ws-seg" role="group" aria-label="밀도">
        {(["compact", "cozy", "roomy"] as Density[]).map((d) => (
          <button
            key={d}
            className={`ws-seg-btn${density === d ? " active" : ""}`}
            onClick={() => onDensityChange(d)}
            title={d}
          >
            {d === "compact" ? "조밀" : d === "cozy" ? "보통" : "넓게"}
          </button>
        ))}
      </div>
    </div>
  );
}

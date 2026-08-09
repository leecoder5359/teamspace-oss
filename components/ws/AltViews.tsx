"use client";

import { useMemo, useState } from "react";
import { Icon } from "./icons";
import { AvatarStack, DDay, Dot, StatusPill, colorFor } from "./ui";
import {
  monthGrid,
  addMonths,
  monthLabel,
  bucketByDay,
  spanOf,
  boundsOf,
  barMetrics,
  toDateKey,
  type Span,
} from "@/lib/viewLayout";
import type { DbProperty, DbRow, SelectOption } from "../DatabaseView";

/* =====================================================================
   갤러리 · 리스트 · 달력 · 타임라인 뷰 (격차 C1).

   표·칸반 2종뿐이라 "같은 데이터를 다르게 본다" 는 데이터베이스의 핵심 이점이
   반쪽이었다. 배치 계산(달력 격자·막대 좌표)은 전부 `lib/viewLayout` 순수
   함수에 있고 여기서는 그리기만 한다 — 윤년·월말·주 경계는 눈으로 못 잡는다.

   네 뷰 모두 **읽기 중심**이다. 편집은 행을 열어(TaskDetail) 한다 — 표·칸반이
   이미 인라인 편집을 맡고 있고, 달력 칸 안에서 값을 고치는 UI 는 오조작이 쉽다.
   ===================================================================== */

type Common = {
  properties: DbProperty[];
  rows: DbRow[];
  titleId: string | null;
  onOpenRow: (rowId: string) => void;
};

const optOf = (prop: DbProperty | undefined, v: unknown): SelectOption | undefined =>
  prop?.config?.options?.find((o) => o.id === v);

function titleOf(row: DbRow, titleId: string | null): string {
  const v = titleId ? row.props[titleId] : null;
  return typeof v === "string" && v.trim() ? v : "(제목 없음)";
}

/** 카드·행에 곁들일 값들(상태·담당자·날짜)을 한곳에서 고른다. */
function useAccents(properties: DbProperty[]) {
  return useMemo(() => {
    const selects = properties.filter((p) => p.type === "select");
    return {
      status: selects.find((p) => /상태|status/i.test(p.name)) ?? selects[0] ?? null,
      date: properties.find((p) => p.type === "date") ?? null,
      person: properties.find((p) => p.type === "person" || /담당|assignee/i.test(p.name)) ?? null,
    };
  }, [properties]);
}

function personNames(row: DbRow, prop: DbProperty | null): string[] {
  if (!prop) return [];
  const v = row.props[prop.id];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" && v.trim() ? [v] : [];
}

/* ───────────────────────── 갤러리 ───────────────────────── */

export function GalleryView({ properties, rows, titleId, onOpenRow }: Common) {
  const acc = useAccents(properties);
  if (rows.length === 0) return <div className="ws-empty-hint">보여줄 행이 없습니다.</div>;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: 12,
        padding: "8px 0",
      }}
    >
      {rows.map((row) => {
        const st = optOf(acc.status ?? undefined, row.props[acc.status?.id ?? ""]);
        return (
          <button
            key={row.id}
            onClick={() => onOpenRow(row.id)}
            style={{
              textAlign: "left",
              background: "var(--surface-card)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 12,
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minHeight: 120,
              cursor: "pointer",
            }}
          >
            {/* 표지 자리 — 이미지 속성이 아직 없으므로 상태 색 띠로 대신한다.
                빈 회색 상자를 두면 '깨진 이미지' 로 읽힌다. */}
            <div
              style={{
                height: 6,
                borderRadius: 999,
                background: st ? colorFor(st.color) : "var(--border-subtle)",
              }}
            />
            <div style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.4, flex: 1 }}>
              {titleOf(row, titleId)}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              {st && <StatusPill label={st.name} color={st.color} />}
              {acc.date && <DDay value={row.props[acc.date.id]} />}
              <span style={{ flex: 1 }} />
              <AvatarStack names={personNames(row, acc.person)} size={20} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── 리스트 ───────────────────────── */

export function ListView({ properties, rows, titleId, onOpenRow }: Common) {
  const acc = useAccents(properties);
  if (rows.length === 0) return <div className="ws-empty-hint">보여줄 행이 없습니다.</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {rows.map((row) => {
        const st = optOf(acc.status ?? undefined, row.props[acc.status?.id ?? ""]);
        return (
          <button
            key={row.id}
            onClick={() => onOpenRow(row.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 8px",
              borderBottom: "1px solid var(--border-subtle)",
              background: "transparent",
              border: "none",
              borderBottomStyle: "solid",
              textAlign: "left",
              cursor: "pointer",
              width: "100%",
            }}
          >
            <Dot color={st ? colorFor(st.color) : "var(--border-subtle)"} />
            <span style={{ flex: 1, fontSize: 13.5 }}>{titleOf(row, titleId)}</span>
            {st && <StatusPill label={st.name} color={st.color} />}
            {acc.date && <DDay value={row.props[acc.date.id]} />}
            <AvatarStack names={personNames(row, acc.person)} size={20} />
          </button>
        );
      })}
    </div>
  );
}

/* ───────────────────────── 달력 ───────────────────────── */

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

export function CalendarView({
  properties,
  rows,
  titleId,
  onOpenRow,
  dateProp,
  today,
}: Common & { dateProp: DbProperty | null; today: string }) {
  const [cursor, setCursor] = useState(() => {
    const [y, m] = today.split("-").map(Number);
    return { year: y, month: m };
  });

  const byDay = useMemo(
    () => (dateProp ? bucketByDay(rows, (r) => r.props[dateProp.id]) : new Map<string, DbRow[]>()),
    [rows, dateProp],
  );
  const weeks = useMemo(() => monthGrid(cursor.year, cursor.month, 0, today), [cursor, today]);
  const acc = useAccents(properties);

  if (!dateProp) {
    return <div className="ws-empty-hint">달력 뷰에는 날짜 속성이 필요합니다. 보드에 날짜 속성을 추가하세요.</div>;
  }

  const undated = rows.length - [...byDay.values()].reduce((n, l) => n + l.length, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 12px" }}>
        <button className="ws-btn-soft" onClick={() => setCursor((c) => addMonths(c.year, c.month, -1))} aria-label="이전 달">
          <Icon name="chevronLeft" size={14} />
        </button>
        <strong style={{ fontSize: 14 }}>{monthLabel(cursor.year, cursor.month)}</strong>
        <button className="ws-btn-soft" onClick={() => setCursor((c) => addMonths(c.year, c.month, 1))} aria-label="다음 달">
          <Icon name="chevronRight" size={14} />
        </button>
        <button
          className="ws-btn-soft"
          onClick={() => {
            const [y, m] = today.split("-").map(Number);
            setCursor({ year: y, month: m });
          }}
        >
          오늘
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "var(--text-disabled)" }}>기준 속성: {dateProp.name}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, background: "var(--border-subtle)", border: "1px solid var(--border-subtle)", borderRadius: 10, overflow: "hidden" }}>
        {WEEKDAYS.map((d) => (
          <div key={d} style={{ background: "var(--surface-sunken)", padding: "6px 8px", fontSize: 12, fontWeight: 600, textAlign: "center" }}>
            {d}
          </div>
        ))}
        {weeks.flat().map((cell) => {
          const list = byDay.get(cell.date) ?? [];
          return (
            <div
              key={cell.date}
              style={{
                background: "var(--surface-card)",
                minHeight: 96,
                padding: 6,
                opacity: cell.inMonth ? 1 : 0.45,
                outline: cell.isToday ? "2px solid var(--color-primary)" : undefined,
                outlineOffset: -2,
              }}
            >
              <div style={{ fontSize: 11.5, fontWeight: cell.isToday ? 700 : 500, marginBottom: 4, color: cell.isToday ? "var(--color-primary)" : "var(--text-disabled)" }}>
                {Number(cell.date.slice(8))}
              </div>
              {list.slice(0, 3).map((row) => {
                const st = optOf(acc.status ?? undefined, row.props[acc.status?.id ?? ""]);
                return (
                  <button
                    key={row.id}
                    onClick={() => onOpenRow(row.id)}
                    title={titleOf(row, titleId)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      fontSize: 11.5,
                      lineHeight: 1.35,
                      padding: "2px 5px",
                      marginBottom: 3,
                      borderRadius: 5,
                      border: "none",
                      cursor: "pointer",
                      background: st ? `color-mix(in srgb, ${colorFor(st.color)} 18%, transparent)` : "var(--surface-sunken)",
                      color: "var(--text-body)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {titleOf(row, titleId)}
                  </button>
                );
              })}
              {list.length > 3 && (
                <div style={{ fontSize: 11, color: "var(--text-disabled)" }}>+{list.length - 3}건</div>
              )}
            </div>
          );
        })}
      </div>

      {undated > 0 && (
        // 날짜 없는 행이 조용히 사라지면 "행이 없어졌다" 로 읽힌다 — 개수를 밝힌다.
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--text-disabled)" }}>
          날짜가 없어 달력에 놓이지 않은 행 {undated}건
        </p>
      )}
    </div>
  );
}

/* ───────────────────────── 타임라인 ───────────────────────── */

export function TimelineView({
  properties,
  rows,
  titleId,
  onOpenRow,
  startProp,
  endProp,
}: Common & { startProp: DbProperty | null; endProp: DbProperty | null }) {
  const acc = useAccents(properties);

  const items = useMemo(() => {
    if (!startProp) return [];
    return rows
      .map((row) => ({
        row,
        span: spanOf(row.props[startProp.id], endProp ? row.props[endProp.id] : null),
      }))
      .filter((x): x is { row: DbRow; span: Span } => x.span !== null);
  }, [rows, startProp, endProp]);

  const bounds = useMemo(() => boundsOf(items.map((i) => i.span)), [items]);

  if (!startProp) {
    return <div className="ws-empty-hint">타임라인 뷰에는 날짜 속성이 필요합니다. 보드에 날짜 속성을 추가하세요.</div>;
  }
  if (!bounds) return <div className="ws-empty-hint">날짜가 채워진 행이 없어 그릴 막대가 없습니다.</div>;

  const missing = rows.length - items.length;

  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-disabled)", marginBottom: 8 }}>
        <span>{bounds.min}</span>
        <span>
          기준: {startProp.name}
          {endProp ? ` → ${endProp.name}` : " (종료 속성 없음 — 하루짜리로 표시)"}
        </span>
        <span>{bounds.max}</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map(({ row, span }) => {
          const m = barMetrics(span, bounds);
          const st = optOf(acc.status ?? undefined, row.props[acc.status?.id ?? ""]);
          return (
            <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={() => onOpenRow(row.id)}
                title={titleOf(row, titleId)}
                style={{
                  width: 180,
                  flexShrink: 0,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  color: "var(--text-body)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {titleOf(row, titleId)}
              </button>
              <div style={{ position: "relative", flex: 1, height: 22, background: "var(--surface-sunken)", borderRadius: 6 }}>
                <button
                  onClick={() => onOpenRow(row.id)}
                  title={`${span.start} → ${span.end}`}
                  style={{
                    position: "absolute",
                    left: `${m.leftPct}%`,
                    width: `${m.widthPct}%`,
                    top: 3,
                    height: 16,
                    minWidth: 6,
                    borderRadius: 5,
                    border: "none",
                    cursor: "pointer",
                    background: st ? colorFor(st.color) : "var(--color-primary)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {missing > 0 && (
        <p style={{ marginTop: 10, fontSize: 12, color: "var(--text-disabled)" }}>
          시작 날짜가 없어 막대를 그리지 못한 행 {missing}건
        </p>
      )}
    </div>
  );
}

/** 뷰가 요구하는 날짜 속성을 고른다 — config.dateProp 우선, 없으면 첫 date 속성. */
export function pickDateProp(properties: DbProperty[], preferredId?: string): DbProperty | null {
  if (preferredId) {
    const hit = properties.find((p) => p.id === preferredId && p.type === "date");
    if (hit) return hit;
  }
  return properties.find((p) => p.type === "date") ?? null;
}

/** 타임라인 종료 속성 — config 지정 > 시작 다음의 date 속성. */
export function pickEndProp(properties: DbProperty[], startId: string | null, preferredId?: string): DbProperty | null {
  if (preferredId) {
    const hit = properties.find((p) => p.id === preferredId && p.type === "date");
    if (hit) return hit;
  }
  const dates = properties.filter((p) => p.type === "date");
  return dates.find((p) => p.id !== startId) ?? null;
}

export { toDateKey };

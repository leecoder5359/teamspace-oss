"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { useSearchParams } from "next/navigation";
import { Icon } from "./ws/icons";
import type { IconName } from "./ws/icons";
import TaskDetail from "./ws/TaskDetail";
import {
  Avatar,
  AvatarStack,
  DDay,
  IdChip,
  LabelChip,
  PriorityTag,
  ProgressBar,
  SeverityBadge,
  StatusPill,
  Dot,
  colorFor,
  ddayInfo,
  shortId,
  type PillMode,
} from "./ws/ui";

export type SelectOption = { id: string; name: string; color: string };

type PropType =
  | "text"
  | "number"
  | "date"
  | "select"
  | "multiselect"
  | "checkbox"
  | "person"
  | "relation";

export type DbProperty = {
  id: string;
  name: string;
  type: PropType;
  config: { options?: SelectOption[] } | null;
  position: number;
};

type DbView = {
  id: string;
  name: string;
  type: "table" | "kanban";
  config: { groupBy?: string } | null;
  position: number;
};

export type DbRow = {
  id: string;
  props: Record<string, unknown>;
  position: number;
  contentPageId?: string | null;
};

type DbPayload = {
  page: { id: string; title: string; kind: string; project: { id: string; name: string; color: string } | null };
  properties: DbProperty[];
  views: DbView[];
  rows: DbRow[];
};

type Reminder = {
  id: string;
  spec: string;
  template: { text?: string; rowId?: string } | null;
};

type Density = "compact" | "cozy" | "roomy";

/* ===== 속성 → 역할 분류 (제네릭 매핑) ===== */
export type Role =
  | "title"
  | "status"
  | "priority"
  | "severity"
  | "progress"
  | "label"
  | "person"
  | "date"
  | "number"
  | "checkbox"
  | "text";

export function classifyRoles(props: DbProperty[]): { roles: Map<string, Role>; titleId: string | null } {
  const roles = new Map<string, Role>();
  const titleProp = props.find((p) => p.type === "text") ?? props[0];
  const titleId = titleProp?.id ?? null;
  for (const p of props) {
    if (p.id === titleId) {
      roles.set(p.id, "title");
      continue;
    }
    const n = p.name.toLowerCase();
    if (p.type === "select" || p.type === "multiselect") {
      if (/상태|status|진행/.test(n)) roles.set(p.id, "status");
      else if (/우선|priority/.test(n)) roles.set(p.id, "priority");
      else if (/심각|중요|severity/.test(n)) roles.set(p.id, "severity");
      else roles.set(p.id, "label");
    } else if (p.type === "person") {
      roles.set(p.id, "person");
    } else if (p.type === "text" && /담당|assignee|manager|작성|owner/.test(n)) {
      roles.set(p.id, "person");
    } else if (p.type === "date") {
      roles.set(p.id, "date");
    } else if (p.type === "number" && /진행|progress|율|%/.test(n)) {
      roles.set(p.id, "progress");
    } else if (p.type === "number") {
      roles.set(p.id, "number");
    } else if (p.type === "checkbox") {
      roles.set(p.id, "checkbox");
    } else {
      roles.set(p.id, "text");
    }
  }
  return { roles, titleId };
}

function optionById(prop: DbProperty | undefined, id: unknown): SelectOption | undefined {
  if (!prop?.config?.options || typeof id !== "string") return undefined;
  return prop.config.options.find((o) => o.id === id);
}

function personNames(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function rowSearchText(row: DbRow, properties: DbProperty[]): string {
  const parts: string[] = [];
  for (const p of properties) {
    const v = row.props[p.id];
    if (p.type === "select") {
      const o = optionById(p, v);
      if (o) parts.push(o.name);
    } else if (typeof v === "string" || typeof v === "number") {
      parts.push(String(v));
    }
  }
  return parts.join(" ").toLowerCase();
}

export default function DatabaseView({
  pageId,
  embedded = false,
  defaultViewType,
}: {
  pageId: string;
  /** 다른 화면(문서 탭 등)에 끼워 넣을 때: 폭/여백 축소 + 자체 타이틀 숨김 */
  embedded?: boolean;
  /** URL ?view 가 없을 때 우선 선택할 뷰 타입(예: "kanban") */
  defaultViewType?: string;
}) {
  const [data, setData] = useState<DbPayload | null>(null);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [density, setDensity] = useState<Density>("cozy");
  const [colorMode, setColorMode] = useState<PillMode>("soft");
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string; color: string }[]>([]);

  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view"); // "kanban" | "table" | null

  const load = useCallback(async () => {
    const res = await fetch(`/api/databases/${pageId}`, { cache: "no-store" });
    if (!res.ok) return;
    const payload = (await res.json()) as DbPayload;
    setData(payload);
    setRows(payload.rows);
    setActiveViewId((prev) => {
      if (prev) return prev;
      const wanted = viewParam || defaultViewType;
      if (wanted) {
        const v = payload.views.find((x) => x.type === wanted);
        if (v) return v.id;
      }
      return payload.views[0]?.id ?? null;
    });
  }, [pageId, viewParam, defaultViewType]);
  useAutoRefresh(load); // W6: 30초 폴링+포커스 갱신

  const loadReminders = useCallback(async () => {
    const res = await fetch(`/api/schedules?databasePageId=${pageId}`, { cache: "no-store" });
    if (!res.ok) return;
    const { schedules } = (await res.json()) as { schedules: Reminder[] };
    setReminders(schedules);
  }, [pageId]);

  // 프로젝트 목록(헤더 배정용)
  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (res.ok) {
        const { projects: pjs } = (await res.json()) as { projects: { id: string; name: string; color: string }[] };
        setProjects(pjs.map((p) => ({ id: p.id, name: p.name, color: p.color })));
      }
    })();
  }, []);

  const assignProject = useCallback(
    async (projectId: string) => {
      const current = data?.page.project?.id ?? "";
      if (projectId === current) return;
      // 프로젝트 배정은 이 보드 페이지 전체(모든 태스크)를 옮긴다 — 실수 방지 확인.
      const target = projectId ? projects.find((p) => p.id === projectId)?.name ?? "프로젝트" : "미분류";
      const ok = window.confirm(
        `이 보드의 모든 태스크(${rows.length}개)가 "${target}"(으)로 함께 이동합니다.\n특정 태스크만 옮기는 게 아닙니다. 계속할까요?`,
      );
      if (!ok) return;
      await fetch(`/api/pages/${pageId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: projectId || null }),
      });
      await load();
    },
    [pageId, load, data, projects, rows],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([load(), loadReminders()]).finally(() => setLoading(false));
  }, [load, loadReminders]);

  // 사이드바의 보드/테이블 클릭(?view 변경)에 반응해 활성 뷰 전환
  useEffect(() => {
    if (!data || !viewParam) return;
    const v = data.views.find((x) => x.type === viewParam);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (v) setActiveViewId(v.id);
  }, [viewParam, data]);

  const activeView = useMemo(
    () => data?.views.find((v) => v.id === activeViewId) ?? data?.views[0] ?? null,
    [data, activeViewId],
  );

  const selectProps = useMemo(
    () => data?.properties.filter((p) => p.type === "select") ?? [],
    [data],
  );

  const { roles, titleId } = useMemo(
    () => (data ? classifyRoles(data.properties) : { roles: new Map<string, Role>(), titleId: null }),
    [data],
  );

  const selectedRow = useMemo(
    () => (selectedRowId ? rows.find((r) => r.id === selectedRowId) ?? null : null),
    [rows, selectedRowId],
  );

  const visibleRows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (q && !rowSearchText(row, data.properties).includes(q)) return false;
      for (const [propId, optId] of Object.entries(filters)) {
        if (optId && row.props[propId] !== optId) return false;
      }
      return true;
    });
  }, [rows, query, filters, data]);

  const updateCell = useCallback(async (rowId: string, propId: string, value: unknown) => {
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, props: { ...r.props, [propId]: value } } : r)),
    );
    await fetch(`/api/rows/${rowId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ props: { [propId]: value } }),
    });
  }, []);

  const addRow = useCallback(
    async (props: Record<string, unknown> = {}) => {
      const res = await fetch(`/api/databases/${pageId}/rows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ props }),
      });
      if (res.ok) {
        const { row } = (await res.json()) as { row: DbRow };
        setRows((prev) => [...prev, row]);
        return row;
      }
      return null;
    },
    [pageId],
  );

  const deleteRow = useCallback(async (rowId: string) => {
    setRows((prev) => prev.filter((r) => r.id !== rowId));
    await fetch(`/api/rows/${rowId}`, { method: "DELETE" });
  }, []);

  const quickAdd = useCallback(
    async (name: string, remindAt: string) => {
      if (!data) return;
      const nameProp = data.properties.find((p) => p.type === "text") ?? data.properties[0];
      const dueProp = data.properties.find((p) => p.type === "date");
      const props: Record<string, unknown> = { [nameProp.id]: name };
      if (remindAt && dueProp) props[dueProp.id] = remindAt.slice(0, 10);
      const row = await addRow(props);
      if (remindAt) {
        await fetch(`/api/schedules`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ remindAt, text: name, databasePageId: pageId, rowId: row?.id }),
        });
        await loadReminders();
      }
    },
    [data, addRow, pageId, loadReminders],
  );

  const cancelReminder = useCallback(async (id: string) => {
    setReminders((prev) => prev.filter((r) => r.id !== id));
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
  }, []);

  if (loading && !data) {
    return <div className={`ws-db${embedded ? " ws-db--embedded" : ""}`}>불러오는 중…</div>;
  }
  if (!data) {
    return <div className={`ws-db${embedded ? " ws-db--embedded" : ""}`}>데이터베이스를 불러오지 못했습니다.</div>;
  }

  return (
    <div className={`ws-db${embedded ? " ws-db--embedded" : ""}`} data-density={density}>
      {!embedded && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
          <h1 className="ws-db-title" style={{ margin: 0 }}>{data.page.title || "Untitled"}</h1>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "3px 8px 3px 10px" }} title="이 보드가 속한 프로젝트">
            <span style={{ width: 8, height: 8, borderRadius: 2, background: data.page.project ? colorFor(data.page.project.color) : "var(--text-disabled)", flex: "0 0 auto" }} />
            <select
              value={data.page.project?.id ?? ""}
              onChange={(e) => void assignProject(e.target.value)}
              aria-label="프로젝트 배정"
              style={{ border: "none", background: "transparent", color: "var(--text-sub)", fontSize: 12.5, fontWeight: 600, fontFamily: "inherit", outline: "none", cursor: "pointer" }}
            >
              <option value="">미분류</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}

      <QuickAdd onAdd={quickAdd} />

      {reminders.length > 0 && (
        <ReminderList
          reminders={reminders}
          properties={data.properties}
          rows={rows}
          onCancel={cancelReminder}
        />
      )}

      <div className="ws-db-toolbar">
        <input
          className="ws-db-search"
          type="search"
          placeholder="검색…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {selectProps.map((p) => (
          <select
            key={p.id}
            className="ws-db-filter"
            value={filters[p.id] ?? ""}
            onChange={(e) => setFilters((prev) => ({ ...prev, [p.id]: e.target.value }))}
          >
            <option value="">{p.name}: 전체</option>
            {(p.config?.options ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ))}
        {(query || Object.values(filters).some(Boolean)) && (
          <button
            className="ws-db-clear"
            onClick={() => {
              setQuery("");
              setFilters({});
            }}
          >
            초기화 ({visibleRows.length}/{rows.length})
          </button>
        )}

        <span className="ws-toolbar-spacer" />

        {activeView?.type === "kanban" && (
          <div className="ws-seg" role="group" aria-label="카드 색상 모드">
            {(["soft", "solid", "bar"] as PillMode[]).map((m) => (
              <button
                key={m}
                className={`ws-seg-btn${colorMode === m ? " active" : ""}`}
                onClick={() => setColorMode(m)}
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
              onClick={() => setDensity(d)}
              title={d}
            >
              {d === "compact" ? "조밀" : d === "cozy" ? "보통" : "넓게"}
            </button>
          ))}
        </div>
      </div>

      <div className="ws-db-tabs">
        {data.views.map((v) => (
          <button
            key={v.id}
            className={`ws-db-tab${v.id === activeView?.id ? " active" : ""}`}
            onClick={() => setActiveViewId(v.id)}
          >
            <Icon name={v.type === "kanban" ? "board" : "table"} size={15} />
            {v.name}
          </button>
        ))}
      </div>

      {activeView?.type === "kanban" ? (
        <KanbanView
          view={activeView}
          properties={data.properties}
          roles={roles}
          titleId={titleId}
          rows={visibleRows}
          colorMode={colorMode}
          density={density}
          onMove={updateCell}
          onOpenRow={setSelectedRowId}
        />
      ) : (
        <TableView
          properties={data.properties}
          roles={roles}
          rows={visibleRows}
          colorMode={colorMode}
          onUpdate={updateCell}
          onAddRow={() => addRow()}
          onDeleteRow={deleteRow}
          onOpenRow={setSelectedRowId}
        />
      )}

      {selectedRow && (
        <TaskDetail
          row={selectedRow}
          properties={data.properties}
          roles={roles}
          titleId={titleId}
          onChange={(propId, value) => updateCell(selectedRow.id, propId, value)}
          onClose={() => setSelectedRowId(null)}
        />
      )}
    </div>
  );
}

/* ===== 간편 할일 알림 등록 ===== */
function QuickAdd({ onAdd }: { onAdd: (name: string, remindAt: string) => void }) {
  const [name, setName] = useState("");
  const [remindAt, setRemindAt] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onAdd(trimmed, remindAt);
    setName("");
    setRemindAt("");
  };

  return (
    <div className="ws-quickadd">
      <input
        className="ws-quickadd-name"
        placeholder="빠른 할 일 추가…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
      />
      <input
        className="ws-quickadd-time"
        type="datetime-local"
        title="알림 시각 (선택)"
        value={remindAt}
        onChange={(e) => setRemindAt(e.target.value)}
      />
      <button className="ws-quickadd-btn" onClick={submit} disabled={!name.trim()}>
        {remindAt ? "알림 추가" : "추가"}
      </button>
    </div>
  );
}

function ReminderList({
  reminders,
  properties,
  rows,
  onCancel,
}: {
  reminders: Reminder[];
  properties: DbProperty[];
  rows: DbRow[];
  onCancel: (id: string) => void;
}) {
  const nameProp = properties.find((p) => p.type === "text") ?? properties[0];
  const label = (r: Reminder) => {
    if (r.template?.rowId) {
      const row = rows.find((x) => x.id === r.template?.rowId);
      const v = row?.props[nameProp.id];
      if (typeof v === "string" && v) return v;
    }
    return r.template?.text ?? "알림";
  };
  return (
    <div className="ws-reminders">
      <div className="ws-reminders-head">
        <Icon name="bell" size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
        예약된 알림 {reminders.length}
      </div>
      {reminders.map((r) => (
        <div key={r.id} className="ws-reminder">
          <span className="ws-reminder-time">
            {new Date(r.spec).toLocaleString("ko-KR", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="ws-reminder-text">{label(r)}</span>
          <button className="ws-reminder-x" title="알림 취소" onClick={() => onCancel(r.id)}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* 역할 → 헤더 아이콘 (디자인 table.jsx 의 컬럼 아이콘 충실도) */
const ROLE_ICON: Record<Role, IconName> = {
  title: "doc",
  status: "board",
  priority: "flag",
  severity: "alert",
  progress: "check",
  label: "tag",
  person: "user",
  date: "calendar",
  number: "hash",
  checkbox: "check",
  text: "doc",
};

/* ===== 셀 값 → 정렬 키 ===== */
function sortValue(row: DbRow, prop: DbProperty, role: Role): string | number {
  const v = row.props[prop.id];
  if (role === "status" || role === "priority" || role === "severity" || role === "label") {
    // 옵션 정의 순서 기준 정렬
    const idx = prop.config?.options?.findIndex((x) => x.id === v) ?? -1;
    return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
  }
  if (role === "date") {
    const info = ddayInfo(v);
    return info.date ? info.date.getTime() : Number.MAX_SAFE_INTEGER;
  }
  if (role === "progress" || role === "number") {
    return typeof v === "number" ? v : -1;
  }
  if (role === "checkbox") return v === true ? 1 : 0;
  return typeof v === "string" ? v.toLowerCase() : "";
}

/* ===== 표 뷰 ===== */
function TableView({
  properties,
  roles,
  rows,
  colorMode,
  onUpdate,
  onAddRow,
  onDeleteRow,
  onOpenRow,
}: {
  properties: DbProperty[];
  roles: Map<string, Role>;
  rows: DbRow[];
  colorMode: PillMode;
  onUpdate: (rowId: string, propId: string, value: unknown) => void;
  onAddRow: () => void;
  onDeleteRow: (rowId: string) => void;
  onOpenRow: (rowId: string) => void;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sortedRows = useMemo(() => {
    if (!sortKey) return rows;
    const prop = properties.find((p) => p.id === sortKey);
    if (!prop) return rows;
    const role = roles.get(prop.id) ?? "text";
    const arr = [...rows];
    arr.sort((a, b) => {
      const av = sortValue(a, prop, role);
      const bv = sortValue(b, prop, role);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortKey, sortDir, properties, roles]);

  const toggleSort = (id: string) => {
    if (sortKey === id) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(id);
      setSortDir("asc");
    }
  };

  return (
    <>
      <div className="ws-table-wrap">
        <table className="ws-table">
          <thead>
            <tr>
              {properties.map((p) => (
                <th key={p.id} className="ws-th-sortable" onClick={() => toggleSort(p.id)}>
                  <span className="ws-th-inner">
                    <Icon className="ws-th-icon" name={ROLE_ICON[roles.get(p.id) ?? "text"]} size={14} />
                    {p.name}
                    {sortKey === p.id && (
                      <Icon
                        className="ws-th-arrow"
                        name={sortDir === "asc" ? "chevronDown" : "chevronRight"}
                        size={13}
                      />
                    )}
                  </span>
                </th>
              ))}
              <th className="ws-table-actions" />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr
                key={row.id}
                className="ws-table-row"
                onClick={(e) => {
                  // 인라인 편집 컨트롤 클릭 시에는 드로어를 열지 않음
                  if ((e.target as HTMLElement).closest("input,select,textarea,button,a,label")) return;
                  onOpenRow(row.id);
                }}
              >
                {properties.map((p) => (
                  <td key={p.id}>
                    <TableCell
                      prop={p}
                      role={roles.get(p.id) ?? "text"}
                      rowId={row.id}
                      value={row.props[p.id]}
                      colorMode={colorMode}
                      onChange={(v) => onUpdate(row.id, p.id, v)}
                    />
                  </td>
                ))}
                <td className="ws-table-actions">
                  <button className="ws-row-del" title="행 삭제" onClick={() => onDeleteRow(row.id)}>
                    <Icon name="close" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="ws-add-row" onClick={onAddRow}>
        <Icon name="plus" size={15} /> 새 행
      </button>
    </>
  );
}

/* select / date 를 표시 프리미티브 + 투명 native 컨트롤 오버레이로 편집 */
function PillSelect({
  prop,
  value,
  display,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  display: React.ReactNode;
  onChange: (v: unknown) => void;
}) {
  const options = prop.config?.options ?? [];
  return (
    <div className="ws-pill-cell">
      {display}
      <select
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={prop.name}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function TableCell({
  prop,
  role,
  rowId,
  value,
  colorMode,
  onChange,
}: {
  prop: DbProperty;
  role: Role;
  rowId: string;
  value: unknown;
  colorMode: PillMode;
  onChange: (v: unknown) => void;
}) {
  const opt = optionById(prop, value);

  if (role === "title") {
    return (
      <div className="ws-cell ws-cell-title">
        <IdChip id={shortId(rowId)} />
        <input
          className="ws-cell-input"
          style={{ fontWeight: 600 }}
          type="text"
          defaultValue={typeof value === "string" ? value : ""}
          onBlur={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  if (role === "status") {
    return (
      <PillSelect
        prop={prop}
        value={value}
        onChange={onChange}
        display={
          opt ? (
            <StatusPill label={opt.name} color={opt.color} mode={colorMode === "bar" ? "soft" : colorMode} />
          ) : (
            <span className="ws-pill-empty">—</span>
          )
        }
      />
    );
  }
  if (role === "priority") {
    return (
      <PillSelect
        prop={prop}
        value={value}
        onChange={onChange}
        display={opt ? <PriorityTag label={opt.name} color={opt.color} /> : <span className="ws-pill-empty">—</span>}
      />
    );
  }
  if (role === "severity") {
    return (
      <PillSelect
        prop={prop}
        value={value}
        onChange={onChange}
        display={opt ? <SeverityBadge label={opt.name} color={opt.color} /> : <span className="ws-pill-empty">—</span>}
      />
    );
  }
  if (role === "label") {
    return (
      <PillSelect
        prop={prop}
        value={value}
        onChange={onChange}
        display={opt ? <LabelChip label={opt.name} color={opt.color} /> : <span className="ws-pill-empty">—</span>}
      />
    );
  }

  if (role === "person") {
    const names = personNames(value);
    return (
      <div className="ws-cell">
        {names.length > 0 ? <Avatar name={names[0]} size={22} /> : null}
        <input
          className="ws-cell-input"
          type="text"
          placeholder="담당자"
          defaultValue={typeof value === "string" ? value : ""}
          onBlur={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  if (role === "date") {
    return (
      <div className="ws-pill-cell">
        <DDay value={value} />
        <input
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label={prop.name}
        />
      </div>
    );
  }

  if (role === "progress") {
    const num = typeof value === "number" ? value : 0;
    return (
      <div className="ws-pill-cell">
        <ProgressBar value={num} />
        <input
          type="number"
          min={0}
          max={100}
          value={typeof value === "number" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
          aria-label={prop.name}
        />
      </div>
    );
  }

  if (role === "checkbox") {
    return (
      <div className="ws-cell">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </div>
    );
  }

  if (role === "number") {
    return (
      <input
        className="ws-cell-input"
        type="number"
        defaultValue={typeof value === "number" ? value : ""}
        onBlur={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    );
  }

  // text
  return (
    <input
      className="ws-cell-input"
      type="text"
      defaultValue={typeof value === "string" ? value : ""}
      onBlur={(e) => onChange(e.target.value)}
    />
  );
}

/* ===== 보드(칸반) 뷰 ===== */
function KanbanView({
  view,
  properties,
  roles,
  titleId,
  rows,
  colorMode,
  density,
  onMove,
  onOpenRow,
}: {
  view: DbView;
  properties: DbProperty[];
  roles: Map<string, Role>;
  titleId: string | null;
  rows: DbRow[];
  colorMode: PillMode;
  density: Density;
  onMove: (rowId: string, propId: string, value: unknown) => void;
  onOpenRow: (rowId: string) => void;
}) {
  // 디자인 DENSITY 맵: compact 는 라벨/진행률/부가정보를 숨겨 카드를 조밀하게.
  const showSecondary = density !== "compact";
  const groupId = view.config?.groupBy ?? "";
  const groupProp = properties.find((p) => p.id === groupId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);

  // 역할별 대표 속성
  const byRole = (r: Role) => properties.find((p) => roles.get(p.id) === r);
  const statusProp = byRole("status");
  const priorityProp = byRole("priority");
  const severityProp = byRole("severity");
  const progressProp = byRole("progress");
  const dateProp = byRole("date");
  const labelProps = properties.filter((p) => roles.get(p.id) === "label");
  const personProps = properties.filter((p) => roles.get(p.id) === "person");
  const titleProp = properties.find((p) => p.id === titleId) ?? properties[0];

  if (!groupProp || !groupProp.config?.options) {
    return <div className="ws-kanban-empty">그룹 기준 속성이 없습니다.</div>;
  }

  const columns: { key: string; label: string; color?: string }[] = [
    { key: "", label: "미지정" },
    ...groupProp.config.options.map((o) => ({ key: o.id, label: o.name, color: o.color })),
  ];

  const rowsByGroup = (key: string) =>
    rows.filter((r) => {
      const v = r.props[groupProp.id];
      return key === "" ? !v : v === key;
    });

  const handleDrop = (colKey: string) => {
    if (dragId) onMove(dragId, groupProp.id, colKey || null);
    setDragId(null);
    setDropCol(null);
  };

  return (
    <div className="ws-kanban" data-color={colorMode}>
      {columns.map((col) => {
        const colRows = rowsByGroup(col.key);
        return (
          <div
            key={col.key || "none"}
            className={`ws-kanban-col${dropCol === col.key ? " drop-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (dropCol !== col.key) setDropCol(col.key);
            }}
            onDragLeave={() => setDropCol((c) => (c === col.key ? null : c))}
            onDrop={() => handleDrop(col.key)}
          >
            <div className="ws-kanban-col-head">
              <Dot color={col.color} />
              <span>{col.label}</span>
              <span className="ws-kanban-count">{colRows.length}</span>
            </div>

            {colRows.length === 0 && <div className="ws-kanban-empty">비어 있음</div>}

            {colRows.map((row) => {
              const title = row.props[titleProp.id];
              const statusOpt =
                statusProp && statusProp.id !== groupProp.id
                  ? optionById(statusProp, row.props[statusProp.id])
                  : undefined;
              const prioOpt = priorityProp ? optionById(priorityProp, row.props[priorityProp.id]) : undefined;
              const sevOpt = severityProp ? optionById(severityProp, row.props[severityProp.id]) : undefined;
              const progress =
                progressProp && typeof row.props[progressProp.id] === "number"
                  ? (row.props[progressProp.id] as number)
                  : null;
              const labels = labelProps
                .map((p) => optionById(p, row.props[p.id]))
                .filter((o): o is SelectOption => Boolean(o));
              const persons = personProps.flatMap((p) => personNames(row.props[p.id]));
              const accent = col.color ? colorFor(col.color) : undefined;

              return (
                <div
                  key={row.id}
                  className={`ws-kanban-card${dragId === row.id ? " dragging" : ""}`}
                  style={accent ? ({ ["--card-accent" as string]: accent } as React.CSSProperties) : undefined}
                  draggable
                  onDragStart={() => setDragId(row.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropCol(null);
                  }}
                  onClick={() => {
                    if (!dragId) onOpenRow(row.id);
                  }}
                >
                  <div className="ws-card-top">
                    <IdChip id={shortId(row.id)} />
                    {statusOpt && <StatusPill label={statusOpt.name} color={statusOpt.color} mode={colorMode === "bar" ? "soft" : colorMode} />}
                    <span style={{ flex: 1 }} />
                    {showSecondary && sevOpt && <SeverityBadge label={sevOpt.name} color={sevOpt.color} />}
                    {prioOpt && <PriorityTag label={prioOpt.name} color={prioOpt.color} />}
                  </div>

                  <div className="ws-card-title">
                    {typeof title === "string" && title ? title : "Untitled"}
                  </div>

                  {showSecondary && labels.length > 0 && (
                    <div className="ws-card-labels">
                      {labels.map((o) => (
                        <LabelChip key={o.id} label={o.name} color={o.color} />
                      ))}
                    </div>
                  )}

                  {showSecondary && progress !== null && (
                    <div className="ws-card-progress">
                      <ProgressBar value={progress} />
                    </div>
                  )}

                  <div className="ws-card-foot">
                    {persons.length > 0 ? (
                      <AvatarStack names={persons} size={22} />
                    ) : (
                      <span className="ws-pill-empty">미지정</span>
                    )}
                    {dateProp && <DDay value={row.props[dateProp.id]} />}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { useSearchParams } from "next/navigation";
import { Icon } from "./ws/icons";
import SharePanel from "./ws/SharePanel";
import PresenceBar from "./ws/PresenceBar";
import { GalleryView, ListView, CalendarView, TimelineView, pickDateProp, pickEndProp } from "./ws/AltViews";
import RelationCell, { type RelationOption } from "./ws/RelationCell";
import { aggOptionsFor, computeAgg, formatAgg, AGG_LABEL, type AggFn } from "@/lib/aggregate";
import { buildRowTree } from "@/lib/subitems";
import { normalizeIds, blockingIds } from "@/lib/relation";
import {
  matchesGroup,
  filterKindOf,
  OPS_BY_KIND,
  OP_LABEL,
  type FilterGroup,
  type FilterOp,
} from "@/lib/dbFilter";
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

/** 뷰 종류별 탭 아이콘 (격차 C1). */
const VIEW_ICON: Record<string, IconName> = {
  table: "table",
  kanban: "board",
  gallery: "panel",
  list: "menu",
  calendar: "calendar",
  timeline: "clock",
};

/** 사용자가 보는 '오늘'(로컬 기준). 서버 UTC 로 계산하면 자정 근처에서 하루가 어긋난다. */
function localTodayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
  config: { options?: SelectOption[]; targetDatabaseId?: string } | null;
  position: number;
};

type DbView = {
  id: string;
  name: string;
  type: "table" | "kanban" | "gallery" | "list" | "calendar" | "timeline";
  config: { groupBy?: string; dateProp?: string; endProp?: string; agg?: Record<string, string>; sort?: { propId: string; dir: "asc" | "desc" } | null; meta?: string[]; filter?: FilterGroup | null } | null;
  position: number;
};

export type DbRow = {
  id: string;
  props: Record<string, unknown>;
  position: number;
  contentPageId?: string | null;
  // 행 자체의 메타 — props 가 아니라 컬럼으로 저장돼 있다(격차 C3).
  createdAt?: string;
  updatedAt?: string;
  createdById?: string | null;
  updatedById?: string | null;
  /** 서브아이템 부모(격차 C6) */
  parentRowId?: string | null;
};

/** 속성이 아니라 행 메타에서 오는 가상 열. 스키마에 PropType 을 늘리지 않는다. */
export const META_COLUMNS = [
  { key: "createdAt", label: "만든 시각" },
  { key: "updatedAt", label: "수정 시각" },
  { key: "createdBy", label: "만든 사람" },
  { key: "updatedBy", label: "수정한 사람" },
] as const;
export type MetaKey = (typeof META_COLUMNS)[number]["key"];

export function metaCell(row: DbRow, key: MetaKey, users: Record<string, string>): string {
  switch (key) {
    case "createdAt":
      return row.createdAt ? new Date(row.createdAt).toLocaleString("ko-KR") : "";
    case "updatedAt":
      return row.updatedAt ? new Date(row.updatedAt).toLocaleString("ko-KR") : "";
    case "createdBy":
      // 이 컬럼은 2026-08-08 에 추가돼 그 전 행은 비어 있다 — 없는 걸 지어내지 않는다
      return row.createdById ? users[row.createdById] ?? row.createdById : "";
    case "updatedBy":
      return row.updatedById ? users[row.updatedById] ?? row.updatedById : "";
  }
}

type DbPayload = {
  page: { id: string; title: string; kind: string; project: { id: string; name: string; color: string } | null };
  properties: DbProperty[];
  views: DbView[];
  rows: DbRow[];
  users?: Record<string, string>;
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
  | "relation"
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
    } else if (p.type === "relation") {
      roles.set(p.id, "relation");
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
  const activeViewRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [density, setDensity] = useState<Density>("cozy");
  // 달력의 '오늘'. 렌더마다 새로 만들면 하이드레이션 불일치가 나므로 한 번만 고정한다.
  const [todayKey] = useState(localTodayKey);
  // relation 속성이 가리키는 보드의 행 목록(격차 C2). propId → [{id,title}]
  const [relationOptions, setRelationOptions] = useState<Map<string, RelationOption[]>>(new Map());
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

  /* relation 속성이 가리키는 보드의 행 제목을 받아 온다(격차 C2).
     값은 행 id 라 그대로 보여 주면 사람이 못 읽는다. /api/tasks 는 이미 D3
     게이트를 통과하므로, 볼 수 없는 보드를 가리키면 후보가 비어 있게 된다. */
  useEffect(() => {
    const rels = (data?.properties ?? []).filter((p) => p.type === "relation");
    if (rels.length === 0) return;
    let cancelled = false;
    (async () => {
      const next = new Map<string, RelationOption[]>();
      for (const p of rels) {
        const target = (p.config as { targetDatabaseId?: string } | null)?.targetDatabaseId;
        if (!target) continue;
        const res = await fetch(`/api/tasks?board=${target}`, { cache: "no-store" }).catch(() => null);
        if (!res?.ok) continue;
        const payload = (await res.json()) as { tasks?: { id: string; title?: string }[] };
        next.set(
          p.id,
          (payload.tasks ?? []).map((t) => ({ id: t.id, title: t.title?.trim() || "(제목 없음)" })),
        );
      }
      if (!cancelled) setRelationOptions(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [data?.properties]);

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

  /** 칸반 컬럼 머리에 낼 집계 — 뷰 config 에서 'none' 이 아닌 첫 열을 쓴다(C6). */
  const groupAgg = useMemo(() => {
    const agg = (activeView?.config?.agg ?? {}) as Record<string, AggFn>;
    const entry = Object.entries(agg).find(([, fn]) => fn && fn !== "none");
    return entry ? { propId: entry[0], fn: entry[1] } : null;
  }, [activeView]);

  /* 의존관계(격차 C6): 선행 태스크가 아직 안 끝난 행을 표시한다.
     같은 보드를 가리키는 relation 속성만 본다 — 다른 보드의 상태 이름까지
     끌어오면 화면 한 줄을 위해 보드 여러 개를 매번 읽어야 한다. */
  const blockedRows = useMemo(() => {
    const props = data?.properties ?? [];
    const relProp = props.find(
      (p) => p.type === "relation" && (p.config as { targetDatabaseId?: string } | null)?.targetDatabaseId === pageId,
    );
    const statusProp = props.find((p) => p.type === "select" && /상태|status|진행/i.test(p.name));
    if (!relProp || !statusProp) return new Map<string, number>();
    const nameOf = (rowId: string) => {
      const r = rows.find((x) => x.id === rowId);
      if (!r) return null;
      const opt = (statusProp.config?.options ?? []).find((o) => o.id === r.props[statusProp.id]);
      return opt?.name ?? null;
    };
    const out = new Map<string, number>();
    for (const r of rows) {
      const n = blockingIds(normalizeIds(r.props[relProp.id]), nameOf).length;
      if (n > 0) out.set(r.id, n);
    }
    return out;
  }, [data?.properties, rows, pageId]);
  useEffect(() => {
    activeViewRef.current = activeView?.id ?? null;
  }, [activeView]);

  // visibleRows 의 useMemo 가 이 값을 쓴다 — 아래에서 선언하면 TDZ 로 첫 렌더가
  // 통째로 터진다(tsc·테스트는 통과하는데 화면이 안 뜬다). 선언 순서가 계약이다.
  const activeFilter = activeView?.config?.filter ?? null;

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
      // 빠른 select 드롭다운(기존)은 그대로 두고, 그 위에 복합 필터를 얹는다 —
      // 자주 쓰는 한 번 클릭을 없애면서까지 표현력을 늘릴 이유가 없다(격차 C4).
      for (const [propId, optId] of Object.entries(filters)) {
        if (optId && row.props[propId] !== optId) return false;
      }
      return matchesGroup(row.props, data.properties, activeFilter);
    });
  }, [rows, query, filters, data, activeFilter]);

  // 낙관적 편집은 실패하면 되돌린다. 종전엔 응답을 버려서 viewer 가 편집하거나
  // 409 가 나도 화면엔 성공으로 남았고, 새로고침해야 사라졌다(전수조사 D4).
  const failEdit = useCallback(async (res: Response, fallback: string) => {
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    setEditError(d.error ?? fallback);
    await load();
  }, [load]);

  /** 정렬을 뷰에 저장한다. 실패해도 화면 정렬은 그대로 두고 알리기만 한다 —
   *  못 저장했다고 방금 누른 정렬을 되돌리면 더 당황스럽다. */
  /** 집계 선택을 뷰 config 에 저장한다(격차 C6). 열마다 독립이라 병합해서 보낸다. */
  const saveViewAgg = useCallback(
    async (propId: string, fn: AggFn) => {
      const viewId = activeViewRef.current;
      if (!viewId) return;
      // 화면은 즉시 반영하고, 서버에는 **바뀐 열만** 보낸다.
      // 전체 agg 를 보내면 두 열을 연달아 바꿀 때 응답 순서가 뒤바뀌며 한쪽이 지워진다.
      setData((prev) =>
        prev
          ? {
              ...prev,
              views: prev.views.map((v) =>
                v.id === viewId
                  ? {
                      ...v,
                      config: {
                        ...(v.config ?? {}),
                        agg: Object.fromEntries(
                          Object.entries({ ...((v.config?.agg ?? {}) as Record<string, string>), [propId]: fn }).filter(
                            ([, x]) => x && x !== "none",
                          ),
                        ),
                      },
                    }
                  : v,
              ),
            }
          : prev,
      );
      const res = await fetch(`/api/databases/${pageId}/views/${viewId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { agg: { [propId]: fn } } }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setEditError(d.error ?? "집계 설정을 저장하지 못했습니다(화면에는 적용됨).");
      }
    },
    [pageId],
  );

  const saveViewSort = useCallback(
    async (sort: { propId: string; dir: "asc" | "desc" } | null) => {
      const viewId = activeViewRef.current;
      if (!viewId) return;
      const res = await fetch(`/api/databases/${pageId}/views/${viewId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { sort } }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setEditError(d.error ?? "정렬을 저장하지 못했습니다(화면에는 적용됨).");
        return;
      }
      // 로컬 data 도 갱신해 두면 뷰를 오갔다 돌아와도 정렬이 유지된다
      setData((prev) =>
        prev
          ? { ...prev, views: prev.views.map((v) => (v.id === viewId ? { ...v, config: { ...(v.config ?? {}), sort } } : v)) }
          : prev,
      );
    },
    [pageId],
  );


  /** 복합 필터를 뷰에 저장한다. 낙관적으로 화면부터 반영하고 실패만 알린다. */
  const saveViewFilter = useCallback(
    async (next: FilterGroup | null) => {
      const viewId = activeViewRef.current;
      if (!viewId) return;
      setData((prev) =>
        prev
          ? { ...prev, views: prev.views.map((v) => (v.id === viewId ? { ...v, config: { ...(v.config ?? {}), filter: next } } : v)) }
          : prev,
      );
      const res = await fetch(`/api/databases/${pageId}/views/${viewId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { filter: next } }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setEditError(d.error ?? "필터를 저장하지 못했습니다.");
      }
    },
    [pageId],
  );

  /** 메타 열 표시 여부를 뷰에 저장한다(정렬과 같은 경로). */
  const saveViewMeta = useCallback(
    async (next: MetaKey[]) => {
      const viewId = activeViewRef.current;
      if (!viewId) return;
      setData((prev) =>
        prev
          ? { ...prev, views: prev.views.map((v) => (v.id === viewId ? { ...v, config: { ...(v.config ?? {}), meta: next } } : v)) }
          : prev,
      );
      const res = await fetch(`/api/databases/${pageId}/views/${viewId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { meta: next } }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setEditError(d.error ?? "열 표시 설정을 저장하지 못했습니다.");
      }
    },
    [pageId],
  );

  const updateCell = useCallback(async (rowId: string, propId: string, value: unknown) => {
    const before = rows;
    setRows((prev) =>
      prev.map((r) => (r.id === rowId ? { ...r, props: { ...r.props, [propId]: value } } : r)),
    );
    const res = await fetch(`/api/rows/${rowId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ props: { [propId]: value } }),
    });
    if (!res.ok) {
      setRows(before);
      await failEdit(res, "저장하지 못했습니다.");
    }
  }, [rows, failEdit]);

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
    const before = rows;
    setRows((prev) => prev.filter((r) => r.id !== rowId));
    const res = await fetch(`/api/rows/${rowId}`, { method: "DELETE" });
    if (!res.ok) {
      setRows(before);
      await failEdit(res, "삭제하지 못했습니다.");
    }
  }, [rows, failEdit]);

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
    const before = reminders;
    setReminders((prev) => prev.filter((r) => r.id !== id));
    const res = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (!res.ok) {
      // 리마인더는 폴링 대상 밖이라 되돌리지 않으면 재방문까지 어긋난 채로 남는다
      setReminders(before);
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setEditError(d.error ?? "리마인더를 취소하지 못했습니다.");
    }
  }, [reminders]);

  if (loading && !data) {
    return <div className={`ws-db${embedded ? " ws-db--embedded" : ""}`}>불러오는 중…</div>;
  }
  if (!data) {
    return <div className={`ws-db${embedded ? " ws-db--embedded" : ""}`}>데이터베이스를 불러오지 못했습니다.</div>;
  }

  return (
    <div className={`ws-db${embedded ? " ws-db--embedded" : ""}`} data-density={density}>
      {editError && (
        // 낙관적 편집이 서버에서 거절됐을 때 — 화면은 이미 되돌려 놓았고 이유만 알린다
        <div
          role="alert"
          style={{
            display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px",
            padding: "8px 12px", borderRadius: 8,
            border: "1px solid var(--color-danger, #F0494E)",
            background: "var(--color-danger-weak, #FEECEC)",
            color: "var(--color-danger, #F0494E)", fontSize: 12.5,
          }}
        >
          <span style={{ flex: 1 }}>{editError}</span>
          <button
            onClick={() => setEditError(null)}
            style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", font: "inherit" }}
            aria-label="닫기"
          >
            ✕
          </button>
        </div>
      )}
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
        {(query || Object.values(filters).some(Boolean) || !!activeFilter?.rules.length) && (
          <button
            className="ws-db-clear"
            onClick={() => {
              setQuery("");
              setFilters({});
              void saveViewFilter(null);
            }}
          >
            초기화 ({visibleRows.length}/{rows.length})
          </button>
        )}

        <details className="ws-filter-builder" style={{ position: "relative" }}>
          <summary
            className="ws-db-filter"
            style={{ cursor: "pointer", listStyle: "none", userSelect: "none" }}
            title="AND/OR 와 연산자를 쓰는 필터 — 뷰에 저장된다"
          >
            필터{activeFilter?.rules.length ? ` ${activeFilter.rules.length}` : ""}
          </summary>
          <div
            style={{
              position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, minWidth: 430,
              background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
              borderRadius: 10, padding: 10, boxShadow: "var(--shadow-md, 0 6px 20px rgba(0,0,0,.12))",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <select
                className="ws-db-filter"
                value={activeFilter?.conj ?? "and"}
                onChange={(e) =>
                  void saveViewFilter({ conj: e.target.value as "and" | "or", rules: activeFilter?.rules ?? [] })
                }
                aria-label="조건 결합"
              >
                <option value="and">모두 만족(AND)</option>
                <option value="or">하나라도(OR)</option>
              </select>
              <span style={{ flex: 1 }} />
              {!!activeFilter?.rules.length && (
                <button className="ws-btn-soft" onClick={() => void saveViewFilter(null)}>
                  전체 해제
                </button>
              )}
            </div>

            {(activeFilter?.rules ?? []).map((rule, i) => {
              const prop = data.properties.find((p) => p.id === rule.propId);
              const kind = filterKindOf(prop?.type ?? "text");
              const ops = OPS_BY_KIND[kind] as readonly FilterOp[];
              const needsValue = !["empty", "notEmpty", "checked", "unchecked"].includes(rule.op);
              const patch = (next: Partial<typeof rule>) => {
                const rules = (activeFilter?.rules ?? []).map((r, j) => (j === i ? { ...r, ...next } : r));
                void saveViewFilter({ conj: activeFilter?.conj ?? "and", rules });
              };
              return (
                <div key={i} style={{ display: "flex", gap: 5, marginBottom: 6, alignItems: "center" }}>
                  <select
                    className="ws-db-filter"
                    value={rule.propId}
                    onChange={(e) => {
                      // 속성이 바뀌면 연산자가 안 맞을 수 있다 — 그 종류의 첫 연산자로 되돌린다
                      const nk = filterKindOf(data.properties.find((p) => p.id === e.target.value)?.type ?? "text");
                      patch({ propId: e.target.value, op: OPS_BY_KIND[nk][0] as FilterOp, value: null });
                    }}
                    aria-label="속성"
                  >
                    {data.properties.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <select
                    className="ws-db-filter"
                    value={rule.op}
                    onChange={(e) => patch({ op: e.target.value as FilterOp })}
                    aria-label="연산자"
                  >
                    {ops.map((o) => (
                      <option key={o} value={o}>{OP_LABEL[o]}</option>
                    ))}
                  </select>
                  {needsValue &&
                    (kind === "select" && prop?.config?.options?.length ? (
                      <select
                        className="ws-db-filter"
                        value={String(rule.value ?? "")}
                        onChange={(e) => patch({ value: e.target.value || null })}
                        aria-label="값"
                      >
                        <option value="">(선택)</option>
                        {prop.config.options.map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="ws-db-filter"
                        type={kind === "date" ? "date" : kind === "number" ? "number" : "text"}
                        value={String(rule.value ?? "")}
                        onChange={(e) => patch({ value: e.target.value || null })}
                        placeholder="값"
                        aria-label="값"
                        style={{ minWidth: 110 }}
                      />
                    ))}
                  <button
                    className="ws-row-del"
                    title="이 조건 삭제"
                    onClick={() =>
                      void saveViewFilter({
                        conj: activeFilter?.conj ?? "and",
                        rules: (activeFilter?.rules ?? []).filter((_, j) => j !== i),
                      })
                    }
                  >
                    <Icon name="close" size={13} />
                  </button>
                </div>
              );
            })}

            <button
              className="ws-btn-soft"
              onClick={() => {
                const first = data.properties[0];
                if (!first) return;
                const k = filterKindOf(first.type);
                void saveViewFilter({
                  conj: activeFilter?.conj ?? "and",
                  rules: [...(activeFilter?.rules ?? []), { propId: first.id, op: OPS_BY_KIND[k][0] as FilterOp, value: null }],
                });
              }}
            >
              + 조건 추가
            </button>
          </div>
        </details>

        {activeView?.type !== "kanban" && (
          <details className="ws-meta-toggle" style={{ position: "relative" }}>
            <summary
              className="ws-db-filter"
              style={{ cursor: "pointer", listStyle: "none", userSelect: "none" }}
              title="만든/수정 시각·사람 열 — 데이터는 원래 저장돼 있었는데 보여줄 곳이 없었다"
            >
              메타 열{(activeView?.config?.meta?.length ?? 0) > 0 ? ` ${activeView?.config?.meta?.length}` : ""}
            </summary>
            <div
              style={{
                position: "absolute", zIndex: 20, top: "calc(100% + 4px)", left: 0, minWidth: 160,
                background: "var(--surface-card)", border: "1px solid var(--border-subtle)",
                borderRadius: 10, padding: 8, boxShadow: "var(--shadow-md, 0 6px 20px rgba(0,0,0,.12))",
              }}
            >
              {META_COLUMNS.map((c) => {
                const cur = (activeView?.config?.meta ?? []) as MetaKey[];
                const on = cur.includes(c.key);
                return (
                  <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 2px", fontSize: 12.5, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() =>
                        void saveViewMeta(on ? cur.filter((x) => x !== c.key) : [...cur, c.key])
                      }
                    />
                    {c.label}
                  </label>
                );
              })}
            </div>
          </details>
        )}

        <PresenceBar pageId={pageId} />
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
            <Icon name={VIEW_ICON[v.type] ?? "table"} size={15} />
            {v.name}
          </button>
        ))}
      </div>

      {activeView?.type === "gallery" ? (
        <GalleryView properties={data.properties} rows={visibleRows} titleId={titleId} onOpenRow={setSelectedRowId} />
      ) : activeView?.type === "list" ? (
        <ListView properties={data.properties} rows={visibleRows} titleId={titleId} onOpenRow={setSelectedRowId} />
      ) : activeView?.type === "calendar" ? (
        <CalendarView
          properties={data.properties}
          rows={visibleRows}
          titleId={titleId}
          onOpenRow={setSelectedRowId}
          dateProp={pickDateProp(data.properties, activeView?.config?.dateProp)}
          today={todayKey}
        />
      ) : activeView?.type === "timeline" ? (
        <TimelineView
          properties={data.properties}
          rows={visibleRows}
          titleId={titleId}
          onOpenRow={setSelectedRowId}
          startProp={pickDateProp(data.properties, activeView?.config?.dateProp)}
          endProp={pickEndProp(data.properties, pickDateProp(data.properties, activeView?.config?.dateProp)?.id ?? null, activeView?.config?.endProp)}
        />
      ) : activeView?.type === "kanban" ? (
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
          groupAgg={groupAgg}
        />
      ) : (
        <TableView
          key={activeView?.id ?? "default"}
          properties={data.properties}
          roles={roles}
          rows={visibleRows}
          colorMode={colorMode}
          onUpdate={updateCell}
          onAddRow={() => addRow()}
          onDeleteRow={deleteRow}
          onOpenRow={setSelectedRowId}
          initialSort={activeView?.config?.sort ?? null}
          onSortChange={saveViewSort}
          meta={(activeView?.config?.meta ?? []) as MetaKey[]}
          users={data.users ?? {}}
          relationOptions={relationOptions}
          agg={(activeView?.config?.agg ?? {}) as Record<string, AggFn>}
          onAggChange={saveViewAgg}
          blockedRows={blockedRows}
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

      {/* 공유 범위(격차 D3) — 보드도 페이지라 같은 패널을 쓴다 */}
      <SharePanel pageId={pageId} />
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
  relation: "link",
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
  initialSort,
  onSortChange,
  meta = [],
  users = {},
  relationOptions,
  agg = {},
  onAggChange,
  blockedRows,
}: {
  properties: DbProperty[];
  roles: Map<string, Role>;
  rows: DbRow[];
  colorMode: PillMode;
  onUpdate: (rowId: string, propId: string, value: unknown) => void;
  onAddRow: () => void;
  onDeleteRow: (rowId: string) => void;
  onOpenRow: (rowId: string) => void;
  initialSort?: { propId: string; dir: "asc" | "desc" } | null;
  onSortChange?: (sort: { propId: string; dir: "asc" | "desc" } | null) => void;
  meta?: MetaKey[];
  users?: Record<string, string>;
  /** propId → 대상 보드의 행 목록(격차 C2) */
  relationOptions?: Map<string, RelationOption[]>;
  /** propId → 집계 함수(격차 C6). 뷰 config 에 저장된다. */
  agg?: Record<string, AggFn>;
  onAggChange?: (propId: string, fn: AggFn) => void;
  /** rowId → 아직 안 끝난 선행 태스크 수(격차 C6) */
  blockedRows?: Map<string, number>;
}) {
  // 정렬은 뷰(DbView.config.sort)에 저장된다. 종전엔 로컬 useState 뿐이라
  // 새로고침하면 사라졌다 — 저장되지 않는 뷰는 뷰가 아니다(격차 C5).
  const [sortKey, setSortKey] = useState<string | null>(initialSort?.propId ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSort?.dir ?? "asc");

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

  // 서브아이템(격차 C6): 정렬된 행을 부모-자식 트리로 편다.
  // 정렬을 켜면 계층이 무의미해지므로, 정렬 중에는 트리를 접지 않고 평평하게 둔다.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const treeRows = useMemo(
    () => (sortKey ? sortedRows.map((r) => ({ ...r, depth: 0, hasChildren: false })) : buildRowTree(sortedRows, collapsed)),
    [sortedRows, collapsed, sortKey],
  );

  const toggleSort = (id: string) => {
    // asc → desc → 해제 순환. 해제가 없으면 "정렬을 끄고 원래 순서로" 가 불가능하다.
    let nextKey: string | null;
    let nextDir: "asc" | "desc";
    if (sortKey !== id) {
      nextKey = id;
      nextDir = "asc";
    } else if (sortDir === "asc") {
      nextKey = id;
      nextDir = "desc";
    } else {
      nextKey = null;
      nextDir = "asc";
    }
    setSortKey(nextKey);
    setSortDir(nextDir);
    onSortChange?.(nextKey ? { propId: nextKey, dir: nextDir } : null);
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
              {meta.map((k) => (
                <th key={k} className="ws-th-meta" title="행 메타 — 읽기 전용">
                  <span className="ws-th-inner">
                    <Icon className="ws-th-icon" name={k.endsWith("By") ? "user" : "calendar"} size={14} />
                    {META_COLUMNS.find((c) => c.key === k)?.label ?? k}
                  </span>
                </th>
              ))}
              <th className="ws-table-actions" />
            </tr>
          </thead>
          <tbody>
            {treeRows.map((row) => (
              <tr
                key={row.id}
                className="ws-table-row"
                onClick={(e) => {
                  // 인라인 편집 컨트롤 클릭 시에는 드로어를 열지 않음
                  if ((e.target as HTMLElement).closest("input,select,textarea,button,a,label")) return;
                  onOpenRow(row.id);
                }}
              >
                {properties.map((p, ci) => (
                  <td key={p.id}>
                    {ci === 0 && (row.depth > 0 || row.hasChildren) && (
                      // 서브아이템(C6): 들여쓰기 + 접기. 자식이 있을 때만 버튼을 낸다.
                      <span style={{ display: "inline-flex", alignItems: "center", width: row.depth * 14 + (row.hasChildren ? 18 : 0), verticalAlign: "middle" }}>
                        <span style={{ width: row.depth * 14 }} />
                        {row.hasChildren && (
                          <button
                            className="ws-row-del"
                            title={collapsed.has(row.id) ? "펼치기" : "접기"}
                            onClick={(e) => {
                              e.stopPropagation();
                              setCollapsed((prev) => {
                                const next = new Set(prev);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              });
                            }}
                          >
                            <Icon name={collapsed.has(row.id) ? "chevronRight" : "chevronDown"} size={13} />
                          </button>
                        )}
                      </span>
                    )}
                    {ci === 0 && (blockedRows?.get(row.id) ?? 0) > 0 && (
                      <span
                        title={`선행 태스크 ${blockedRows!.get(row.id)}건이 아직 끝나지 않았습니다`}
                        style={{ marginRight: 6, fontSize: 11, fontWeight: 700, color: "#E0900F", whiteSpace: "nowrap" }}
                      >
                        ⛔{blockedRows!.get(row.id)}
                      </span>
                    )}
                    <TableCell
                      prop={p}
                      role={roles.get(p.id) ?? "text"}
                      rowId={row.id}
                      value={row.props[p.id]}
                      colorMode={colorMode}
                      onChange={(v) => onUpdate(row.id, p.id, v)}
                      relationOptions={relationOptions?.get(p.id)}
                    />
                  </td>
                ))}
                {meta.map((k) => (
                  <td key={k} className="ws-td-meta" style={{ color: "var(--text-muted)", fontSize: 12, whiteSpace: "nowrap" }}>
                    {metaCell(row, k, users)}
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
          {/* 집계 줄(격차 C6) — 열마다 함수를 고르면 뷰 config 에 저장된다. */}
          <tfoot>
            <tr className="ws-table-foot">
              {properties.map((p) => {
                const fn = agg[p.id] ?? "none";
                const opts = aggOptionsFor(p.type);
                return (
                  <td key={p.id} style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                    <select
                      value={fn}
                      onChange={(e) => onAggChange?.(p.id, e.target.value as AggFn)}
                      title="집계"
                      style={{
                        background: "transparent",
                        border: "none",
                        color: fn === "none" ? "var(--text-disabled)" : "var(--text-body)",
                        fontSize: 12,
                        cursor: "pointer",
                        maxWidth: "100%",
                      }}
                    >
                      {opts.map((o) => (
                        <option key={o} value={o}>
                          {o === "none" ? "집계 —" : AGG_LABEL[o]}
                        </option>
                      ))}
                    </select>
                    {fn !== "none" && (
                      <span style={{ marginLeft: 6 }}>
                        {formatAgg(fn, computeAgg(fn, rows.map((r) => r.props[p.id])))}
                      </span>
                    )}
                  </td>
                );
              })}
              {meta.map((k) => (
                <td key={k} />
              ))}
              <td />
            </tr>
          </tfoot>
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
  relationOptions,
}: {
  prop: DbProperty;
  role: Role;
  rowId: string;
  value: unknown;
  colorMode: PillMode;
  onChange: (v: unknown) => void;
  /** relation 셀이 고를 수 있는 대상 보드의 행들(격차 C2) */
  relationOptions?: RelationOption[];
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

  if (role === "relation") {
    return (
      <RelationCell
        value={value}
        options={relationOptions ?? []}
        onChange={(ids) => onChange(ids)}
      />
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
  groupAgg,
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
  /** 컬럼 머리에 낼 집계(격차 C6). 뷰 config 의 첫 집계 열을 쓴다. */
  groupAgg?: { propId: string; fn: AggFn } | null;
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
              {/* 그룹 집계(격차 C6): 표에서 고른 집계를 칸반 컬럼 머리에도 보여준다.
                  "이 컬럼에 남은 공수" 같은 걸 열별로 보려면 이게 있어야 한다. */}
              {groupAgg && (
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-disabled)", whiteSpace: "nowrap" }}>
                  {formatAgg(groupAgg.fn, computeAgg(groupAgg.fn, colRows.map((r) => r.props[groupAgg.propId])))}
                </span>
              )}
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

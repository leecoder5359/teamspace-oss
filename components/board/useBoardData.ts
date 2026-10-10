"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import type { RelationOption } from "../ws/RelationCell";
import type { FilterGroup } from "@/lib/dbFilter";

/* ===== 보드(데이터베이스) 데이터 계층 (T-4a) =====
   DatabaseView 에서 fetch·상태를 떼어 낸 것. 뷰 상태(활성 뷰·필터·밀도 등)는 모른다 —
   뷰 config 저장도 viewId 를 인자로 받는다. URL·메서드·본문·에러 문구는 분리 전 그대로다. */

export type SelectOption = { id: string; name: string; color: string };

export type PropType =
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

export type DbViewConfig = {
  groupBy?: string;
  dateProp?: string;
  endProp?: string;
  agg?: Record<string, string>;
  sort?: { propId: string; dir: "asc" | "desc" } | null;
  meta?: string[];
  filter?: FilterGroup | null;
};

export type DbView = {
  id: string;
  name: string;
  type: "table" | "kanban" | "gallery" | "list" | "calendar" | "timeline";
  config: DbViewConfig | null;
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

export type DbPayload = {
  page: { id: string; title: string; kind: string; project: { id: string; name: string; color: string } | null };
  properties: DbProperty[];
  views: DbView[];
  rows: DbRow[];
  users?: Record<string, string>;
};

export type Reminder = {
  id: string;
  spec: string;
  template: { text?: string; rowId?: string } | null;
};

export type BoardProject = { id: string; name: string; color: string; archivedAt?: string | null };

const JSON_HEADERS = { "content-type": "application/json" };

export function useBoardData(
  pageId: string,
  opts: {
    /** 보드를 읽을 때마다(첫 로드·폴링·실패 복구) 호출 — 활성 뷰 고르기 같은 화면 쪽 반응용 */
    onLoad?: (payload: DbPayload) => void;
    /** 값이 바뀌면(첫 렌더 제외) 보드·리마인더를 다시 읽는다 — loading 은 건드리지 않는다.
        화면은 ?view·defaultViewType 을 묶어 넘긴다(사이드바 보드/테이블 전환 시 재조회). */
    refetchKey?: string;
  } = {},
) {
  const [data, setData] = useState<DbPayload | null>(null);
  const [rows, setRows] = useState<DbRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  // relation 속성이 가리키는 보드의 행 목록(격차 C2). propId → [{id,title}]
  const [relationOptions, setRelationOptions] = useState<Map<string, RelationOption[]>>(new Map());
  const [projects, setProjects] = useState<BoardProject[]>([]);

  // onLoad 는 화면이 매 렌더 새로 만들 수 있다 — load 의 정체성을 흔들지 않게 ref 로 든다
  const onLoadRef = useRef(opts.onLoad);
  useEffect(() => {
    onLoadRef.current = opts.onLoad;
  }, [opts.onLoad]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/databases/${pageId}`, { cache: "no-store" });
    if (!res.ok) return;
    const payload = (await res.json()) as DbPayload;
    setData(payload);
    setRows(payload.rows);
    onLoadRef.current?.(payload);
  }, [pageId]);
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
        const res = await fetch(`/api/tasks?board=${target}&status=all&limit=all`, { cache: "no-store" }).catch(() => null);
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
      // 보관 프로젝트 소속 보드도 헤더 이름이 나오도록 전부 받고, 선택지는 아래에서 거른다
      const res = await fetch("/api/projects?archived=all", { cache: "no-store" });
      if (res.ok) {
        const { projects: pjs } = (await res.json()) as { projects: BoardProject[] };
        setProjects(pjs.map((p) => ({ id: p.id, name: p.name, color: p.color, archivedAt: p.archivedAt ?? null })));
      }
    })();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    Promise.all([load(), loadReminders()]).finally(() => setLoading(false));
  }, [load, loadReminders]);

  // refetchKey 변경 시 재조회. 마지막 키를 ref 로 들고 있어 첫 실행·pageId 변경(위 effect 가 이미 읽음)은 건너뛴다.
  const refetchKey = opts.refetchKey;
  const lastRefetchKey = useRef(refetchKey);
  useEffect(() => {
    if (lastRefetchKey.current === refetchKey) return;
    lastRefetchKey.current = refetchKey;
    void load();
    void loadReminders();
  }, [refetchKey, load, loadReminders]);

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
      const res = await fetch(`/api/pages/${pageId}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ projectId: projectId || null }),
      });
      // 사이드바·문서 목록의 공유 페이지 캐시를 비운다 — 안 그러면 다른 화면이 최대 5초 옛 프로젝트로 보인다
      if (res.ok) window.dispatchEvent(new Event("pages:changed"));
      await load();
    },
    [pageId, load, data, projects, rows],
  );

  // 낙관적 편집은 실패하면 되돌린다. 종전엔 응답을 버려서 viewer 가 편집하거나
  // 409 가 나도 화면엔 성공으로 남았고, 새로고침해야 사라졌다(전수조사 D4).
  const failEdit = useCallback(async (res: Response, fallback: string) => {
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    setError(d.error ?? fallback);
    await load();
  }, [load]);

  /** 뷰 config 저장. 서버에는 `body`(바뀐 키만)를, 화면에는 `apply` 결과를 반영한다.
   *  optimistic 이면 화면부터 바꾸고 실패만 알린다. 아니면 성공했을 때만 화면에 반영한다.
   *  어느 쪽이든 실패해도 되돌리지 않는다 — 방금 누른 설정이 사라지면 더 당황스럽다. */
  const saveViewConfig = useCallback(
    async (
      viewId: string,
      body: DbViewConfig,
      apply: (config: DbViewConfig) => DbViewConfig,
      fallback: string,
      optimistic = true,
    ) => {
      const applyLocal = () =>
        setData((prev) =>
          prev
            ? { ...prev, views: prev.views.map((v) => (v.id === viewId ? { ...v, config: apply(v.config ?? {}) } : v)) }
            : prev,
        );
      if (optimistic) applyLocal();
      let res: Response;
      try {
        res = await fetch(`/api/databases/${pageId}/views/${viewId}`, {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ config: body }),
        });
      } catch {
        // 네트워크 단절 등 fetch 자체가 거부돼도 호출부로 던지지 않고 알리기만 한다
        setError(fallback);
        return;
      }
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? fallback);
        return;
      }
      if (!optimistic) applyLocal();
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
      headers: JSON_HEADERS,
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
        headers: JSON_HEADERS,
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
          headers: JSON_HEADERS,
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
      setError(d.error ?? "리마인더를 취소하지 못했습니다.");
    }
  }, [reminders]);

  // 선택지는 활성 + 현재 소속(보관이어도)만 — 이름·이동 토스트는 전체 목록으로 찾는다
  const currentProjectId = data?.page.project?.id ?? null;
  const projectOptions = projects.filter((p) => !p.archivedAt || p.id === currentProjectId);

  return {
    data,
    rows,
    setRows,
    reminders,
    projects: projectOptions,
    relationOptions,
    loading,
    error,
    setError,
    load,
    loadReminders,
    assignProject,
    saveViewConfig,
    updateCell,
    addRow,
    deleteRow,
    quickAdd,
    cancelReminder,
  };
}

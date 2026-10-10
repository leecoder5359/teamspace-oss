"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { useIsMobile } from "@/lib/useIsMobile";
import { getPages } from "@/lib/pagesClient";

/* =====================================================================
   캘린더 (design app/calendar.jsx 반영) — 월/주/일 뷰 + 스코프 필터 + 이벤트 상세.
   앱 이벤트는 종일(태스크 마감일·문서 수정일)이라 시간 그리드 대신 종일 리스트형.
   - 마감(deadline): /api/tasks 의 due
   - 문서(document): /api/pages 의 doc 수정일(updatedAt)
   이벤트 클릭 → 상세 모달(연결 태스크는 보드, 문서는 문서로 이동).
   ===================================================================== */

type Task = { id: string; title: string; due: string | null; status: string | null; statusColor: string | null };
type DocPage = { id: string; title: string; kind: string; updatedAt: string };
type Schedule = { id: string; spec: string; template: { text?: string } | null };

type Scope = "deadline" | "document" | "reminder";
type CalEvent = {
  id: string;
  scope: Scope;
  date: string; // YYYY-MM-DD
  title: string;
  taskId?: string;
  docId?: string;
  time?: string | null; // 리마인더 시각(HH:MM)
  statusColor?: string | null;
  status?: string | null;
};

const SCOPES: Record<Scope, { label: string; color: string; icon: "calendar" | "doc" | "bell" }> = {
  deadline: { label: "마감", color: "#F5A623", icon: "calendar" },
  document: { label: "문서", color: "#0CA5B0", icon: "doc" },
  reminder: { label: "리마인더", color: "#7165E3", icon: "bell" },
};
const WD = ["일", "월", "화", "수", "목", "금", "토"];
type View = "month" | "week" | "day";

const pad = (n: number) => String(n).padStart(2, "0");
const toKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function dateKey(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toKey(d);
}
const startOfWeek = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export default function Calendar() {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [docs, setDocs] = useState<DocPage[]>([]);
  const [reminders, setReminders] = useState<Schedule[]>([]);
  const [databaseId, setDatabaseId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [view, setView] = useState<View>("month");
  const [ref, setRef] = useState(() => new Date());
  const [scopeOn, setScopeOn] = useState<Record<Scope, boolean>>({ deadline: true, document: true, reminder: true });
  const [sel, setSel] = useState<CalEvent | null>(null);

  const today = useMemo(() => new Date(), []);

  useEffect(() => {
    void (async () => {
    try {
      const [tRes, pRes, sRes] = await Promise.all([
        fetch("/api/tasks?status=all&limit=all", { cache: "no-store" }),
        getPages(),
        fetch("/api/schedules", { cache: "no-store" }),
      ]);
      if (!tRes.ok) throw new Error(`tasks ${tRes.status}`);
      const tData = (await tRes.json()) as { tasks: Task[]; databaseId: string | null };
      setTasks(tData.tasks);
      setDatabaseId(tData.databaseId);
      if (pRes.ok) {
        const pData = pRes.data as { pages: DocPage[] };
        setDocs(pData.pages.filter((p) => p.kind === "doc"));
      }
      if (sRes.ok) {
        const sData = (await sRes.json()) as { schedules: Schedule[] };
        setReminders(sData.schedules);
      }
      setLoaded(true);
    } catch {
      setLoadError(true);
    }
    })();
  }, [attempt]);

  // 이벤트 + 날짜별 그룹
  const { byDate, total } = useMemo(() => {
    const evs: CalEvent[] = [];
    for (const t of tasks ?? []) {
      const k = dateKey(t.due);
      if (k) evs.push({ id: "d_" + t.id, scope: "deadline", date: k, title: t.title, taskId: t.id, status: t.status, statusColor: t.statusColor });
    }
    for (const d of docs) {
      const k = dateKey(d.updatedAt);
      if (k) evs.push({ id: "doc_" + d.id, scope: "document", date: k, title: d.title, docId: d.id });
    }
    for (const r of reminders) {
      const k = dateKey(r.spec);
      const text = r.template?.text?.trim();
      if (k && text) {
        const dt = new Date(r.spec);
        const time = Number.isNaN(dt.getTime()) ? null : `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
        evs.push({ id: "rem_" + r.id, scope: "reminder", date: k, title: text, time });
      }
    }
    const map = new Map<string, CalEvent[]>();
    for (const e of evs.filter((e) => scopeOn[e.scope])) {
      const arr = map.get(e.date) ?? [];
      arr.push(e);
      map.set(e.date, arr);
    }
    return { byDate: map, total: evs.length };
  }, [tasks, docs, reminders, scopeOn]);

  // 현재 뷰 범위(스코프 개수 표시용)
  const weekStart = startOfWeek(ref);
  const inRange = (k: string) => {
    if (view === "month") return k.startsWith(`${ref.getFullYear()}-${pad(ref.getMonth() + 1)}`);
    if (view === "week") return k >= toKey(weekStart) && k <= toKey(addDays(weekStart, 6));
    return k === toKey(ref);
  };
  const rangeCount: Record<Scope, number> = { deadline: 0, document: 0, reminder: 0 };
  byDate.forEach((arr, k) => { if (inRange(k)) for (const e of arr) rangeCount[e.scope]++; });

  const label =
    view === "month"
      ? `${ref.getFullYear()}년 ${ref.getMonth() + 1}월`
      : view === "week"
        ? `${weekStart.getMonth() + 1}월 ${weekStart.getDate()}일 – ${addDays(weekStart, 6).getMonth() + 1}월 ${addDays(weekStart, 6).getDate()}일`
        : `${ref.getFullYear()}년 ${ref.getMonth() + 1}월 ${ref.getDate()}일 (${WD[ref.getDay()]})`;
  const shift = (n: number) => {
    if (view === "month") setRef(new Date(ref.getFullYear(), ref.getMonth() + n, 1));
    else setRef(addDays(ref, n * (view === "week" ? 7 : 1)));
  };

  // 월 그리드: 1일이 속한 주의 일요일부터 6주(42칸)
  const monthGridStart = startOfWeek(new Date(ref.getFullYear(), ref.getMonth(), 1));
  const monthCells = Array.from({ length: 42 }, (_, i) => addDays(monthGridStart, i));
  const weekCells = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const cols = view === "day" ? 1 : 7;

  return (
    <div className="ws-db">
      {/* 상단 바 */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
          <Icon name="calendar" /> 캘린더
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginLeft: 4 }}>
          <button className="ws-btn-soft" onClick={() => shift(-1)} title="이전"><Icon name="chevronLeft" /></button>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)", minWidth: 150, textAlign: "center", whiteSpace: "nowrap" }}>{label}</div>
          <button className="ws-btn-soft" onClick={() => shift(1)} title="다음"><Icon name="chevronRight" /></button>
        </div>
        <button className="ws-btn-soft" onClick={() => setRef(new Date())}>오늘</button>
        <div className="ws-seg" role="group" aria-label="뷰">
          {(["month", "week", "day"] as View[]).map((v) => (
            <button key={v} className={`ws-seg-btn${view === v ? " active" : ""}`} onClick={() => setView(v)}>
              {v === "month" ? "월" : v === "week" ? "주" : "일"}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {(Object.keys(SCOPES) as Scope[]).map((s) => {
            const sc = SCOPES[s];
            const on = scopeOn[s];
            return (
              <button
                key={s}
                onClick={() => setScopeOn((p) => ({ ...p, [s]: !p[s] }))}
                title={sc.label}
                style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 30, padding: "0 11px", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 12.5, fontWeight: 600, border: `1px solid ${on ? `color-mix(in srgb, ${sc.color} 45%, transparent)` : "var(--border-default)"}`, background: on ? `color-mix(in srgb, ${sc.color} 13%, var(--surface-card))` : "var(--surface-card)", color: on ? `color-mix(in srgb, ${sc.color} 76%, var(--text-strong))` : "var(--text-muted)" }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 999, background: on ? sc.color : "var(--text-disabled)", flex: "0 0 auto" }} />
                {sc.label}
                {rangeCount[s] ? <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.8 }}>{rangeCount[s]}</span> : null}
              </button>
            );
          })}
        </div>
      </div>

      {loaded && total === 0 && (
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 12 }}>
          마감일이 설정된 태스크와 문서 수정 이력이 캘린더에 표시됩니다.
        </p>
      )}

      {/* 모바일: min-width 가로 스크롤 (일 뷰는 단일 컬럼이라 제외) */}
      <div style={{ overflowX: isMobile && view !== "day" ? "auto" : undefined, margin: isMobile && view !== "day" ? "0 -14px" : undefined, padding: isMobile && view !== "day" ? "0 14px 4px" : undefined }}>
        <div style={{ minWidth: isMobile && view !== "day" ? 640 : undefined }}>
          {view !== "day" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, marginBottom: 6 }}>
              {WD.map((w, i) => (
                <div key={w} style={{ fontSize: 12, fontWeight: 700, textAlign: "center", padding: "4px 0", color: i === 0 ? "#F0494E" : i === 6 ? "#2F62FF" : "var(--text-muted)" }}>{w}</div>
              ))}
            </div>
          )}
          {loadError ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 4px", fontSize: 13, color: "var(--text-sub)" }}>
              <span>캘린더를 불러오지 못했어요.</span>
              <button className="ws-btn-soft" onClick={() => { setLoadError(false); setAttempt((n) => n + 1); }}>다시 시도</button>
            </div>
          ) : !loaded ? (
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6 }} aria-busy="true">
              {Array.from({ length: view === "month" ? 42 : view === "week" ? 7 : 1 }, (_, i) => (
                <div key={i} className="ws-skeleton" style={{ minHeight: view === "month" ? 94 : 220, borderRadius: 10, border: "1px solid var(--border-subtle)" }} />
              ))}
            </div>
          ) : (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 6 }}>
            {view === "month" && monthCells.map((d, i) => <DayCell key={i} d={d} inMonth={d.getMonth() === ref.getMonth()} events={byDate.get(toKey(d)) ?? []} today={today} onSelect={setSel} />)}
            {view === "week" && weekCells.map((d, i) => <DayCell key={i} d={d} inMonth tall events={byDate.get(toKey(d)) ?? []} today={today} onSelect={setSel} />)}
            {view === "day" && <DayCell d={ref} inMonth tall events={byDate.get(toKey(ref)) ?? []} today={today} onSelect={setSel} />}
          </div>
          )}
        </div>
      </div>

      {sel && (
        <EventDetail
          ev={sel}
          databaseId={databaseId}
          onClose={() => setSel(null)}
          onOpenTask={() => { if (databaseId) router.push(`/p/${databaseId}?view=table`); }}
          onOpenDoc={() => { if (sel.docId) router.push(`/p/${sel.docId}`); }}
        />
      )}
    </div>
  );
}

/* ── 이벤트 알약 ── */
function EventPill({ e, onSelect }: { e: CalEvent; onSelect: (e: CalEvent) => void }) {
  const sc = SCOPES[e.scope];
  const color = e.scope === "deadline" && e.statusColor ? e.statusColor : sc.color;
  return (
    <button
      onClick={(ev) => { ev.stopPropagation(); onSelect(e); }}
      title={e.title}
      style={{ display: "flex", alignItems: "center", gap: 5, width: "100%", textAlign: "left", border: "none", cursor: "pointer", height: 19, padding: "0 6px", borderRadius: 5, fontSize: 11, fontWeight: 600, font: "inherit", background: `color-mix(in srgb, ${color} 15%, var(--surface-card))`, color: `color-mix(in srgb, ${color} 80%, var(--text-strong))` }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 999, background: color, flex: "0 0 auto" }} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {e.scope === "deadline" ? `${e.title} 마감` : e.scope === "reminder" && e.time ? `${e.time} ${e.title}` : e.title}
      </span>
    </button>
  );
}

/* ── 날짜 셀 ── */
function DayCell({ d, inMonth, tall, events, today, onSelect }: { d: Date; inMonth: boolean; tall?: boolean; events: CalEvent[]; today: Date; onSelect: (e: CalEvent) => void }) {
  const dow = d.getDay();
  const isToday = toKey(d) === toKey(today);
  const limit = tall ? 12 : 3;
  return (
    <div style={{ minHeight: tall ? 220 : 94, borderRadius: 10, border: "1px solid var(--border-subtle)", background: inMonth ? "var(--surface-card)" : "var(--surface-sunken)", padding: 6, display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", justifyContent: tall ? "flex-start" : "flex-end", marginBottom: 2 }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 20, height: 20, padding: "0 6px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: isToday ? "var(--color-primary)" : "transparent", color: isToday ? "#fff" : !inMonth ? "var(--text-disabled)" : dow === 0 ? "#F0494E" : dow === 6 ? "#2F62FF" : "var(--text-muted)" }}>
          {tall ? `${d.getMonth() + 1}/${d.getDate()} (${WD[dow]})` : d.getDate()}
        </span>
      </div>
      {events.slice(0, limit).map((e) => <EventPill key={e.id} e={e} onSelect={onSelect} />)}
      {events.length > limit && <span style={{ fontSize: 10.5, color: "var(--text-muted)", paddingLeft: 4 }}>+{events.length - limit}</span>}
    </div>
  );
}

/* ── 이벤트 상세 모달 ── */
function EventDetail({
  ev,
  databaseId,
  onClose,
  onOpenTask,
  onOpenDoc,
}: {
  ev: CalEvent;
  databaseId: string | null;
  onClose: () => void;
  onOpenTask: () => void;
  onOpenDoc: () => void;
}) {
  const sc = SCOPES[ev.scope];
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(25,31,40,0.40)", zIndex: 900 }} />
      <div role="dialog" aria-modal="true" style={{ position: "fixed", left: "50%", top: "50%", transform: "translate(-50%,-50%)", zIndex: 901, width: "min(440px, calc(100vw - 32px))", maxHeight: "calc(100dvh - 64px)", overflow: "auto", background: "var(--surface-card)", border: "1px solid var(--border-subtle)", borderRadius: 18, boxShadow: "var(--ds-shadow-lg, var(--shadow-lg))", padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: `color-mix(in srgb, ${sc.color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${sc.color} 78%, var(--text-strong))` }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: sc.color }} />{sc.label}
          </span>
          <span style={{ flex: 1 }} />
          <button className="ws-icon-btn" onClick={onClose} title="닫기"><Icon name="close" size={18} /></button>
        </div>

        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "-0.01em", lineHeight: 1.35 }}>
          {ev.scope === "deadline" ? `${ev.title} 마감` : ev.title}
        </h3>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, fontSize: 12.5, color: "var(--text-sub)" }}>
          <Icon name="calendar" size={14} /> {ev.date.replace(/-/g, ". ")}{ev.scope === "reminder" && ev.time ? ` · ${ev.time}` : ""}
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-disabled)", letterSpacing: "0.02em", marginBottom: 7 }}>
            {ev.scope === "deadline" ? "연결된 태스크" : ev.scope === "document" ? "문서" : "알림"}
          </div>
          {ev.scope === "reminder" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", borderRadius: 9, padding: "9px 11px" }}>
              <span style={{ width: 26, height: 26, borderRadius: 7, flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${sc.color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${sc.color} 78%, var(--text-strong))` }}>
                <Icon name="bell" size={15} />
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "var(--text-body)" }}>{ev.title}</span>
            </div>
          ) : (
            <button
              onClick={ev.scope === "deadline" ? onOpenTask : onOpenDoc}
              disabled={ev.scope === "deadline" && !databaseId}
              className="ws-listrow"
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", border: "1px solid var(--border-subtle)", background: "var(--surface-card)", borderRadius: 9, padding: "9px 11px", cursor: "pointer", font: "inherit" }}
            >
              <span style={{ width: 26, height: 26, borderRadius: 7, flex: "0 0 auto", display: "flex", alignItems: "center", justifyContent: "center", background: `color-mix(in srgb, ${sc.color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${sc.color} 78%, var(--text-strong))` }}>
                <Icon name={sc.icon} size={15} />
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ev.title}
              </span>
              <Icon name="chevronRight" size={16} />
            </button>
          )}
        </div>
      </div>
    </>
  );
}

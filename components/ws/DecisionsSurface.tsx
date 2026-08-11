"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* 결정(decisions) surface — 의사결정 기록. /api/decisions.
   디자인(docs-hub/decisions.jsx) 반영: 타임라인/표/카드 3뷰 + 상태필터 + 검색 + 상세 드로어.
   project(실 id)면 필터+기본 소속. rich ADR 필드(이유/대안)는 스키마 밖이라 보유 필드로 구성. */

type Status = "proposed" | "accepted" | "superseded";
type Decision = {
  id: string;
  title: string;
  context: string | null;
  decision: string | null;
  status: Status;
  decidedAt: string;
  project: { name: string; color: string } | null;
};
type ViewMode = "timeline" | "table" | "cards";

const STATUS_META: Record<Status, { label: string; color: string }> = {
  proposed: { label: "제안", color: "#F5A623" },
  accepted: { label: "승인", color: "#12B886" },
  superseded: { label: "대체됨", color: "#9AA0A6" },
};
const REAL = (p: string) => p && p !== "__none__";
const projColor = (c: string) => (c === "blue" ? "#2F62FF" : c);
const fmtDate = (s: string) => new Date(s).toLocaleDateString("ko-KR");

export default function DecisionsSurface({ project }: { project: string }) {
  const [list, setList] = useState<Decision[] | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [context, setContext] = useState("");
  const [decision, setDecision] = useState("");
  const [status, setStatus] = useState<Status>("accepted");
  const [busy, setBusy] = useState(false);

  const [view, setView] = useState<ViewMode>("timeline");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | Status>("all");
  const [selId, setSelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = REAL(project) ? `?projectId=${project}` : "";
    const res = await fetch(`/api/decisions${qs}`, { cache: "no-store" });
    const data = (await res.json()) as { decisions: Decision[] };
    setList(data.decisions);
  }, [project]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), context, decision, status, projectId: REAL(project) ? project : undefined }),
      });
      setTitle(""); setContext(""); setDecision(""); setStatus("accepted"); setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function setStat(id: string, s: Status) {
    setBusy(true);
    try {
      await fetch(`/api/decisions/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: s }) });
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/decisions/${id}`, { method: "DELETE" });
      setSelId((cur) => (cur === id ? null : cur));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (list ?? []).filter((d) => {
      if (filter !== "all" && d.status !== filter) return false;
      if (ql && !d.title.toLowerCase().includes(ql) && !(d.decision ?? "").toLowerCase().includes(ql)) return false;
      return true;
    });
  }, [list, q, filter]);

  if (list === null) return <div style={{ padding: 40 }} />;
  const sel = list.find((d) => d.id === selId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>결정 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{rows.length}</span></span>
        <div className="ws-search" style={{ flex: "0 1 200px" }}>
          <span style={{ display: "flex", color: "var(--text-muted)" }}><Icon name="search" size={14} /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="결정 검색" aria-label="결정 검색" />
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value as "all" | Status)} style={{ ...inp, width: "auto" }} aria-label="상태 필터">
          <option value="all">전체 상태</option>
          <option value="proposed">제안</option>
          <option value="accepted">승인</option>
          <option value="superseded">대체됨</option>
        </select>
        <div className="ws-seg" role="group" aria-label="뷰">
          {([["timeline", "clock"], ["table", "table"], ["cards", "board"]] as [ViewMode, "clock" | "table" | "board"][]).map(([v, ic]) => (
            <button key={v} className={`ws-seg-btn${view === v ? " active" : ""}`} onClick={() => setView(v)} title={v === "timeline" ? "타임라인" : v === "table" ? "표" : "카드"}>
              <Icon name={ic} size={15} />
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 결정 추가</button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: view === "table" ? 1000 : view === "cards" ? 1100 : 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              {/* 빈 상태의 '첫 결정 기록' 으로 열었을 때 바로 입력할 수 있게 */}
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="결정 제목 (예: 인증은 Auth.js로 간다)" style={inp} />
              <textarea value={context} onChange={(e) => setContext(e.target.value)} placeholder="배경/맥락" rows={2} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <textarea value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="결정 내용" rows={2} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                <select value={status} onChange={(e) => setStatus(e.target.value as Status)} style={{ ...inp, width: "auto" }}>
                  <option value="proposed">제안</option>
                  <option value="accepted">승인</option>
                  <option value="superseded">대체됨</option>
                </select>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !title.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="flag" size={32} /></span>
              {list.length > 0 ? (
                <>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>조건에 맞는 결정이 없어요</div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>기록된 결정 {list.length}건이 검색어·상태 필터에 걸러졌습니다.</div>
                  <div style={{ marginTop: 14 }}>
                    <button className="ws-btn-soft" onClick={() => { setQ(""); setFilter("all"); }}>필터 지우기</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>결정 기록이 없어요</div>
                  <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>
                    무엇을 왜 그렇게 정했는지 남겨 두지 않으면 몇 달 뒤 같은 논의를 처음부터 다시 합니다.
                    에이전트·CLI(<code>pnpm ws decision add</code>)로 쌓인 결정도 여기 모입니다.
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <button style={primary} onClick={() => setOpen(true)}>첫 결정 기록</button>
                  </div>
                </>
              )}
            </div>
          ) : view === "table" ? (
            <DecisionTable rows={rows} onOpen={setSelId} />
          ) : view === "cards" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
              {rows.map((d) => <DecisionCard key={d.id} d={d} onOpen={() => setSelId(d.id)} />)}
            </div>
          ) : (
            <div className="ws-tl">
              {rows.map((d) => <DecisionTimelineItem key={d.id} d={d} onOpen={() => setSelId(d.id)} />)}
            </div>
          )}
        </div>
      </div>

      {sel && (
        <DecisionDetail d={sel} busy={busy} onClose={() => setSelId(null)} onStat={setStat} onRemove={remove} />
      )}
    </div>
  );
}

/* ── 타임라인 아이템 ── */
function DecisionTimelineItem({ d, onOpen }: { d: Decision; onOpen: () => void }) {
  const s = STATUS_META[d.status];
  const sup = d.status === "superseded";
  return (
    <div className="ws-tl-item" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      style={{ display: "flex", gap: 12, cursor: "pointer" }}>
      <div style={{ flex: "0 0 auto", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: 4 }}>
        <span style={{ width: 11, height: 11, borderRadius: 999, background: s.color, boxShadow: `0 0 0 4px color-mix(in srgb, ${s.color} 18%, transparent)` }} />
        <span style={{ flex: 1, width: 2, background: "var(--border-subtle)", marginTop: 4 }} />
      </div>
      <div className="ws-listrow" style={{ flex: 1, minWidth: 0, border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 12, opacity: sup ? 0.74 : 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 5 }}>
          <StatusPill status={d.status} />
          {d.project && <ProjTag p={d.project} />}
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{fmtDate(d.decidedAt)}</span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", textDecoration: sup ? "line-through" : "none", textDecorationColor: "var(--border-default)" }}>{d.title}</div>
        {d.decision && <p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--text-sub)", lineHeight: 1.55, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{d.decision}</p>}
      </div>
    </div>
  );
}

/* ── 카드 ── */
function DecisionCard({ d, onOpen }: { d: Decision; onOpen: () => void }) {
  const sup = d.status === "superseded";
  return (
    <div className="ws-listrow" onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(); }}
      style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16, cursor: "pointer", display: "flex", flexDirection: "column", gap: 9, opacity: sup ? 0.74 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusPill status={d.status} />
        {d.project && <ProjTag p={d.project} />}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{fmtDate(d.decidedAt)}</span>
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", lineHeight: 1.35, textDecoration: sup ? "line-through" : "none", textDecorationColor: "var(--border-default)" }}>{d.title}</div>
      {d.decision && <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-sub)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{d.decision}</p>}
    </div>
  );
}

/* ── 표 ── */
function DecisionTable({ rows, onOpen }: { rows: Decision[]; onOpen: (id: string) => void }) {
  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, overflow: "hidden", background: "var(--surface-card)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-subtle)", color: "var(--text-muted)", fontSize: 12 }}>
            <th style={th}>결정</th><th style={{ ...th, width: 92 }}>상태</th><th style={{ ...th, width: 140 }}>프로젝트</th><th style={{ ...th, width: 100 }}>날짜</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const sup = d.status === "superseded";
            return (
              <tr key={d.id} className="ws-listrow" onClick={() => onOpen(d.id)} style={{ cursor: "pointer", borderBottom: "1px solid var(--border-subtle)" }}>
                <td style={{ ...td, fontWeight: 600, color: "var(--text-strong)", textDecoration: sup ? "line-through" : "none", textDecorationColor: "var(--border-default)" }}>{d.title}</td>
                <td style={td}><StatusPill status={d.status} /></td>
                <td style={{ ...td, color: "var(--text-sub)" }}>{d.project ? <ProjTag p={d.project} /> : "—"}</td>
                <td style={{ ...td, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtDate(d.decidedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── 상세 드로어 ── */
function DecisionDetail({ d, busy, onClose, onStat, onRemove }: { d: Decision; busy: boolean; onClose: () => void; onStat: (id: string, s: Status) => void; onRemove: (id: string) => void }) {
  return (
    <div className="ws-drawer-wrap">
      <div className="ws-scrim" onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(25,31,40,0.40)" }} />
      <aside className="ws-drawer" role="dialog" aria-modal="true">
        <header className="ws-drawer-head">
          <StatusPill status={d.status} />
          {d.project && <ProjTag p={d.project} />}
          <span className="ws-drawer-head-spacer" style={{ flex: 1 }} />
          <button className="ws-icon-btn" onClick={onClose} title="닫기"><Icon name="close" size={18} /></button>
        </header>
        <div className="ws-drawer-body">
          <h2 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "-0.01em", lineHeight: 1.35 }}>{d.title}</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-muted)", marginBottom: 18 }}>
            <Icon name="calendar" size={14} /> {fmtDate(d.decidedAt)}
          </div>

          {d.context && (
            <Section label="배경 / 맥락"><p style={prose}>{d.context}</p></Section>
          )}
          {d.decision && (
            <Section label="결정">
              <div style={{ padding: "11px 13px", borderRadius: 10, background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{d.decision}</div>
            </Section>
          )}
          {!d.context && !d.decision && (
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>본문이 없는 결정이에요.</p>
          )}
        </div>
        <footer className="ws-drawer-foot">
          {d.status !== "accepted" && <button className="ws-btn-soft" disabled={busy} onClick={() => onStat(d.id, "accepted")}>승인으로</button>}
          {d.status !== "superseded" && <button className="ws-btn-soft" disabled={busy} onClick={() => onStat(d.id, "superseded")}>대체됨</button>}
          <span style={{ flex: 1 }} />
          <button className="ws-btn-soft" disabled={busy} onClick={() => onRemove(d.id)} title="삭제"><Icon name="close" size={14} /> 삭제</button>
        </footer>
      </aside>
    </div>
  );
}

function StatusPill({ status }: { status: Status }) {
  const s = STATUS_META[status];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: `color-mix(in srgb, ${s.color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${s.color} 80%, var(--text-strong))` }}>
      <span style={{ width: 6, height: 6, borderRadius: 999, background: s.color }} />{s.label}
    </span>
  );
}
function ProjTag({ p }: { p: { name: string; color: string } }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text-sub)" }}>
      <span style={{ width: 7, height: 7, borderRadius: 2, background: projColor(p.color) }} />{p.name}
    </span>
  );
}
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.02em", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

const inp: CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)",
  background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit",
};
const primary: CSSProperties = {
  padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer",
  border: "1px solid transparent", background: "var(--color-primary)", color: "#fff",
};
const th: CSSProperties = { textAlign: "left", padding: "10px 14px", fontWeight: 600 };
const td: CSSProperties = { padding: "11px 14px", verticalAlign: "middle" };
const prose: CSSProperties = { margin: 0, fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.7, whiteSpace: "pre-wrap" };

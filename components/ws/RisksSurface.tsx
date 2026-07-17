"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* 리스크(risks) surface — 위험·이슈. /api/risks.
   디자인 반영: 상태 필터 + 행 클릭 상세 드로어(설명/심각도/상태 + 완화·종료·삭제). */

type Sev = "low" | "medium" | "high";
type St = "open" | "mitigated" | "closed";
type Risk = { id: string; title: string; description: string | null; severity: Sev; status: St; project: { name: string; color: string } | null };

const SEV: Record<Sev, { label: string; color: string }> = {
  high: { label: "높음", color: "#F0494E" },
  medium: { label: "보통", color: "#F5A623" },
  low: { label: "낮음", color: "#12B886" },
};
const ST: Record<St, { label: string; color: string }> = {
  open: { label: "열림", color: "#F0494E" },
  mitigated: { label: "완화됨", color: "#F5A623" },
  closed: { label: "종료", color: "#9AA0A6" },
};
const REAL = (p: string) => p && p !== "__none__";
const projColor = (c: string) => (c === "blue" ? "#2F62FF" : c);

export default function RisksSurface({ project }: { project: string }) {
  const [list, setList] = useState<Risk[] | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Sev>("medium");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | St>("all");
  const [selId, setSelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = REAL(project) ? `?projectId=${project}` : "";
    const data = (await (await fetch(`/api/risks${qs}`, { cache: "no-store" })).json()) as { risks: Risk[] };
    setList(data.risks);
  }, [project]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/risks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, description, severity, projectId: REAL(project) ? project : undefined }) });
      setTitle(""); setDescription(""); setSeverity("medium"); setOpen(false);
      await load();
    } finally { setBusy(false); }
  }
  async function setStat(id: string, s: St) { setBusy(true); try { await fetch(`/api/risks/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: s }) }); await load(); } finally { setBusy(false); } }
  async function remove(id: string) { setBusy(true); try { await fetch(`/api/risks/${id}`, { method: "DELETE" }); setSelId((c) => (c === id ? null : c)); await load(); } finally { setBusy(false); } }

  const rows = useMemo(() => (list ?? []).filter((r) => filter === "all" || r.status === filter), [list, filter]);
  if (list === null) return <div style={{ padding: 40 }} />;
  const sel = list.find((r) => r.id === selId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>리스크 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{rows.length}</span></span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as "all" | St)} style={{ ...inp, width: "auto" }} aria-label="상태 필터">
          <option value="all">전체 상태</option>
          <option value="open">열림</option>
          <option value="mitigated">완화됨</option>
          <option value="closed">종료</option>
        </select>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 리스크 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="리스크 제목" style={inp} />
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명/영향" rows={2} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                <select value={severity} onChange={(e) => setSeverity(e.target.value as Sev)} style={{ ...inp, width: "auto" }}>
                  <option value="high">심각도: 높음</option>
                  <option value="medium">심각도: 보통</option>
                  <option value="low">심각도: 낮음</option>
                </select>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !title.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}
          {rows.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="alert" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>리스크가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>위험·이슈를 기록해 추적하세요.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((r) => {
                const sv = SEV[r.severity], st = ST[r.status];
                return (
                  <div key={r.id} className="ws-listrow" onClick={() => setSelId(r.id)} role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setSelId(r.id); }}
                    style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16, cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={pill(sv.color)}>{sv.label}</span>
                      <span style={pill(st.color)}><span style={{ width: 6, height: 6, borderRadius: 999, background: st.color }} />{st.label}</span>
                      {r.project && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text-sub)" }}><span style={{ width: 7, height: 7, borderRadius: 2, background: projColor(r.project.color) }} />{r.project.name}</span>}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 10 }}>{r.title}</div>
                    {r.description && <p style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.6, margin: "8px 0 0", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{r.description}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {sel && (
        <div className="ws-drawer-wrap">
          <div className="ws-scrim" onClick={() => setSelId(null)} style={{ position: "absolute", inset: 0, background: "rgba(25,31,40,0.40)" }} />
          <aside className="ws-drawer" role="dialog" aria-modal="true">
            <header className="ws-drawer-head">
              <span style={pill(SEV[sel.severity].color)}>{SEV[sel.severity].label}</span>
              <span style={pill(ST[sel.status].color)}><span style={{ width: 6, height: 6, borderRadius: 999, background: ST[sel.status].color }} />{ST[sel.status].label}</span>
              <span className="ws-drawer-head-spacer" style={{ flex: 1 }} />
              <button className="ws-icon-btn" onClick={() => setSelId(null)} title="닫기"><Icon name="close" size={18} /></button>
            </header>
            <div className="ws-drawer-body">
              <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "-0.01em", lineHeight: 1.35 }}>{sel.title}</h2>
              {sel.project && <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: "var(--text-sub)", marginBottom: 14 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: projColor(sel.project.color) }} />{sel.project.name}</div>}
              {sel.description ? (
                <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.02em", marginBottom: 8 }}>설명 / 영향
                  <p style={{ margin: "8px 0 0", fontWeight: 400, fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{sel.description}</p>
                </div>
              ) : <p style={{ fontSize: 13, color: "var(--text-muted)" }}>설명이 없는 리스크예요.</p>}
            </div>
            <footer className="ws-drawer-foot">
              {sel.status !== "mitigated" && <button className="ws-btn-soft" disabled={busy} onClick={() => setStat(sel.id, "mitigated")}>완화</button>}
              {sel.status !== "closed" && <button className="ws-btn-soft" disabled={busy} onClick={() => setStat(sel.id, "closed")}>종료</button>}
              <span style={{ flex: 1 }} />
              <button className="ws-btn-soft" disabled={busy} onClick={() => remove(sel.id)} title="삭제"><Icon name="close" size={14} /> 삭제</button>
            </footer>
          </aside>
        </div>
      )}
    </div>
  );
}

const pill = (color: string): CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: `color-mix(in srgb, ${color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${color} 80%, var(--text-strong))` });
const inp: CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit" };
const primary: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff" };

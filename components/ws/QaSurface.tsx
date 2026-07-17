"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* QA surface — 테스트 시나리오. /api/qa.
   디자인 반영: 상태 필터 + 행 클릭 상세 드로어(단계/기대 + 통과·실패·삭제). */

type St = "pending" | "pass" | "fail";
type Qa = { id: string; title: string; steps: string | null; expected: string | null; status: St; project: { name: string; color: string } | null };

const ST: Record<St, { label: string; color: string }> = {
  pending: { label: "대기", color: "#9AA0A6" },
  pass: { label: "통과", color: "#12B886" },
  fail: { label: "실패", color: "#F0494E" },
};
const REAL = (p: string) => p && p !== "__none__";
const projColor = (c: string) => (c === "blue" ? "#2F62FF" : c);

export default function QaSurface({ project }: { project: string }) {
  const [list, setList] = useState<Qa[] | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | St>("all");
  const [selId, setSelId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const qs = REAL(project) ? `?projectId=${project}` : "";
    const data = (await (await fetch(`/api/qa${qs}`, { cache: "no-store" })).json()) as { scenarios: Qa[] };
    setList(data.scenarios);
  }, [project]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/qa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, steps, expected, projectId: REAL(project) ? project : undefined }) });
      setTitle(""); setSteps(""); setExpected(""); setOpen(false);
      await load();
    } finally { setBusy(false); }
  }
  async function setStat(id: string, s: St) { setBusy(true); try { await fetch(`/api/qa/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: s }) }); await load(); } finally { setBusy(false); } }
  async function remove(id: string) { setBusy(true); try { await fetch(`/api/qa/${id}`, { method: "DELETE" }); setSelId((c) => (c === id ? null : c)); await load(); } finally { setBusy(false); } }

  const rows = useMemo(() => (list ?? []).filter((q) => filter === "all" || q.status === filter), [list, filter]);
  if (list === null) return <div style={{ padding: 40 }} />;
  const sel = list.find((q) => q.id === selId) ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>QA <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{rows.length}</span></span>
        <select value={filter} onChange={(e) => setFilter(e.target.value as "all" | St)} style={{ ...inp, width: "auto" }} aria-label="상태 필터">
          <option value="all">전체 상태</option>
          <option value="pending">대기</option>
          <option value="pass">통과</option>
          <option value="fail">실패</option>
        </select>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 시나리오 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="시나리오 제목" style={inp} />
              <textarea value={steps} onChange={(e) => setSteps(e.target.value)} placeholder="단계" rows={2} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <textarea value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="기대 결과" rows={2} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !title.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}
          {rows.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="check" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>시나리오가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>테스트 시나리오를 등록해 통과/실패를 추적하세요.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((q) => {
                const st = ST[q.status];
                return (
                  <div key={q.id} className="ws-listrow" onClick={() => setSelId(q.id)} role="button" tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter") setSelId(q.id); }}
                    style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16, cursor: "pointer" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={pill(st.color)}><span style={{ width: 6, height: 6, borderRadius: 999, background: st.color }} />{st.label}</span>
                      {q.project && <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--text-sub)" }}><span style={{ width: 7, height: 7, borderRadius: 2, background: projColor(q.project.color) }} />{q.project.name}</span>}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 10 }}>{q.title}</div>
                    {q.steps && <p style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.6, margin: "8px 0 0", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}><b>단계:</b> {q.steps}</p>}
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
              <span style={pill(ST[sel.status].color)}><span style={{ width: 6, height: 6, borderRadius: 999, background: ST[sel.status].color }} />{ST[sel.status].label}</span>
              <span className="ws-drawer-head-spacer" style={{ flex: 1 }} />
              <button className="ws-icon-btn" onClick={() => setSelId(null)} title="닫기"><Icon name="close" size={18} /></button>
            </header>
            <div className="ws-drawer-body">
              <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "-0.01em", lineHeight: 1.35 }}>{sel.title}</h2>
              {sel.project && <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, color: "var(--text-sub)", marginBottom: 14 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: projColor(sel.project.color) }} />{sel.project.name}</div>}
              <Sect label="단계">{sel.steps ? <pre style={prose}>{sel.steps}</pre> : <p style={{ ...prose, color: "var(--text-muted)" }}>단계가 없어요.</p>}</Sect>
              <Sect label="기대 결과">{sel.expected ? <pre style={prose}>{sel.expected}</pre> : <p style={{ ...prose, color: "var(--text-muted)" }}>기대 결과가 없어요.</p>}</Sect>
            </div>
            <footer className="ws-drawer-foot">
              {sel.status !== "pass" && <button className="ws-btn-soft" disabled={busy} onClick={() => setStat(sel.id, "pass")}>통과</button>}
              {sel.status !== "fail" && <button className="ws-btn-soft" disabled={busy} onClick={() => setStat(sel.id, "fail")}>실패</button>}
              <span style={{ flex: 1 }} />
              <button className="ws-btn-soft" disabled={busy} onClick={() => remove(sel.id)} title="삭제"><Icon name="close" size={14} /> 삭제</button>
            </footer>
          </aside>
        </div>
      )}
    </div>
  );
}

function Sect({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-muted)", letterSpacing: "0.02em", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}

const pill = (color: string): CSSProperties => ({ display: "inline-flex", alignItems: "center", gap: 5, height: 22, padding: "0 9px", borderRadius: 999, fontSize: 11.5, fontWeight: 700, background: `color-mix(in srgb, ${color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${color} 80%, var(--text-strong))` });
const inp: CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit" };
const primary: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff" };
const prose: CSSProperties = { margin: 0, fontFamily: "inherit", fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" };

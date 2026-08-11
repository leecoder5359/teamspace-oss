"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";
import ExtractPanel from "./ExtractPanel";

/* 완료 기준(DoD) surface — 체크리스트. /api/dod. 제품 공통. */

type Item = { id: string; text: string; done: boolean };
type Proposal = { text: string; status: "new" | "duplicate" | "conflict"; existingId?: string };

export default function DodSurface() {
  const [list, setList] = useState<Item[] | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function load() {
    const data = (await (await fetch("/api/dod", { cache: "no-store" })).json()) as { items: Item[] };
    setList(data.items);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/dod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      setText("");
      await load();
    } finally { setBusy(false); }
  }
  async function toggle(id: string, done: boolean) { setBusy(true); try { await fetch(`/api/dod/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ done }) }); await load(); } finally { setBusy(false); } }
  async function remove(id: string) { setBusy(true); try { await fetch(`/api/dod/${id}`, { method: "DELETE" }); await load(); } finally { setBusy(false); } }

  if (list === null) return <div style={{ padding: 40 }} />;
  const doneN = list.filter((i) => i.done).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>완료 기준 (DoD) <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{doneN}/{list.length}</span></span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setExtractOpen((v) => !v)}><Icon name="doc" size={15} /> 문서에서 추출</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} placeholder="완료 기준 항목 추가 후 Enter" style={{ ...inp, flex: 1 }} />
            <button style={primary} disabled={busy || !text.trim()} onClick={add}>추가</button>
          </div>
          {extractOpen && (
            <ExtractPanel<Proposal>
              label="문서에서 완료 기준 추출 (AI)"
              endpoint="/api/dod/extract"
              runningText="문서를 읽고 완료 기준을 정리하는 중입니다(수십 초 걸릴 수 있어요)."
              emptyText="추출된 완료 기준이 없습니다."
              keyOf={(p) => p.text}
              renderProposal={(p) => <div style={{ fontSize: 13, color: "var(--text-body)", lineHeight: 1.55 }}>{p.text}</div>}
              onAccept={(p) =>
                fetch("/api/dod", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: p.text }) })
              }
              onAccepted={load}
            />
          )}
          {list.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="check" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>DoD 항목이 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>‘완료’의 기준을 합의해 두지 않으면 매번 다시 다툽니다. 위 입력칸에 항목을 적거나, 이미 쓴 문서가 있으면 거기서 뽑아 오세요.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button style={primary} onClick={() => inputRef.current?.focus()}>첫 항목 적기</button>
                <button className="ws-btn-soft" onClick={() => setExtractOpen(true)}><Icon name="doc" size={15} /> 문서에서 추출</button>
              </div>
            </div>
          ) : (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", overflow: "hidden" }}>
              {list.map((i, idx) => (
                <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderTop: idx > 0 ? "1px solid var(--border-subtle)" : "none" }}>
                  <button onClick={() => toggle(i.id, !i.done)} disabled={busy} title="토글" style={{ width: 18, height: 18, flex: "0 0 auto", borderRadius: 5, cursor: "pointer", border: i.done ? "none" : "1.5px solid var(--border-default)", background: i.done ? "var(--color-success, #12B886)" : "transparent", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {i.done && <Icon name="check" size={12} />}
                  </button>
                  <span style={{ flex: 1, fontSize: 13.5, color: i.done ? "var(--text-muted)" : "var(--text-body)", textDecoration: i.done ? "line-through" : "none" }}>{i.text}</span>
                  <button className="ws-btn-soft" disabled={busy} onClick={() => remove(i.id)} title="삭제"><Icon name="close" size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const inp: CSSProperties = { padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit" };
const primary: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff", whiteSpace: "nowrap" };

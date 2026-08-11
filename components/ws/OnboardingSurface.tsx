"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";
import ExtractPanel from "./ExtractPanel";

/* 온보딩(onboarding) surface — 시작 가이드 단계. /api/onboarding. 제품 공통. */

type Step = { id: string; title: string; body: string | null };
type Proposal = {
  title: string;
  body: string;
  status: "new" | "duplicate" | "conflict";
  existingId?: string;
  existingBody?: string;
};

export default function OnboardingSurface() {
  const [list, setList] = useState<Step[] | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);

  async function load() {
    const data = (await (await fetch("/api/onboarding", { cache: "no-store" })).json()) as { steps: Step[] };
    setList(data.steps);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, body }) });
      setTitle(""); setBody(""); setOpen(false);
      await load();
    } finally { setBusy(false); }
  }
  async function remove(id: string) { setBusy(true); try { await fetch(`/api/onboarding/${id}`, { method: "DELETE" }); await load(); } finally { setBusy(false); } }

  if (list === null) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>온보딩 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{list.length}</span></span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setExtractOpen((v) => !v)}><Icon name="doc" size={15} /> 문서에서 추출</button>
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 단계 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              {/* 빈 상태의 '첫 단계 추가' 로 열었을 때 바로 입력할 수 있게 */}
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="단계 제목 (예: 개발 환경 세팅)" style={inp} />
              <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="설명" rows={3} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !title.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}
          {extractOpen && (
            <ExtractPanel<Proposal>
              label="문서에서 온보딩 단계 추출 (AI)"
              endpoint="/api/onboarding/extract"
              runningText="문서를 읽고 온보딩 단계를 정리하는 중입니다(수십 초 걸릴 수 있어요)."
              emptyText="추출된 단계가 없습니다."
              keyOf={(p) => p.title}
              renderProposal={(p) => (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-strong)" }}>{p.title}</div>
                  {p.body && <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 2, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{p.body}</div>}
                  {p.status === "conflict" && p.existingBody && (
                    <div style={{ fontSize: 12, color: "#E0900F", marginTop: 4 }}>기존: {p.existingBody}</div>
                  )}
                </>
              )}
              onAccept={(p) =>
                p.existingId
                  ? fetch(`/api/onboarding/${p.existingId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: p.body }) })
                  : fetch("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: p.title, body: p.body }) })
              }
              onAccepted={load}
            />
          )}
          {list.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="user" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>온보딩 단계가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>새 팀원이 첫날 무엇부터 해야 하는지 여기 순서대로 쌓입니다. 직접 적거나, 세팅 문서가 이미 있으면 거기서 단계를 뽑아 오세요.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button style={primary} onClick={() => setOpen(true)}>첫 단계 추가</button>
                <button className="ws-btn-soft" onClick={() => setExtractOpen(true)}><Icon name="doc" size={15} /> 문서에서 추출</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {list.map((s, idx) => (
                <div key={s.id} style={{ display: "flex", gap: 12, border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16 }}>
                  <div style={{ width: 26, height: 26, flex: "0 0 auto", borderRadius: 999, background: "var(--color-primary-weak)", color: "var(--color-primary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 800 }}>{idx + 1}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-strong)" }}>{s.title}</div>
                    {s.body && <p style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.6, margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{s.body}</p>}
                  </div>
                  <button className="ws-btn-soft" disabled={busy} onClick={() => remove(s.id)} title="삭제" style={{ flex: "0 0 auto", alignSelf: "flex-start" }}><Icon name="close" size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const inp: CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit" };
const primary: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff" };

"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";
import ExtractPanel from "./ExtractPanel";

/* 용어집(glossary) surface — 도메인 용어. /api/glossary. 제품 공통(프로젝트 무관). */

type Term = { id: string; term: string; definition: string; sourcePageId?: string | null };
type Page = { id: string; title: string; kind: string };
type Proposal = { term: string; definition: string; status: "new" | "duplicate" | "conflict"; existingId?: string; existingDefinition?: string };

export default function GlossarySurface() {
  const [list, setList] = useState<Term[] | null>(null);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [busy, setBusy] = useState(false);

  const [extractOpen, setExtractOpen] = useState(false);
  // pages 는 추출 패널이 아니라 목록의 '출처' 칩(제목 표시)에 쓴다 — 패널은 스스로 문서를 읽어온다.
  const [pages, setPages] = useState<Page[]>([]);

  async function load() {
    const res = await fetch("/api/glossary", { cache: "no-store" });
    const data = (await res.json()) as { terms: Term[] };
    setList(data.terms);
  }
  async function loadPages() {
    const res = await fetch("/api/pages", { cache: "no-store" });
    if (res.ok) {
      const d = (await res.json()) as { pages: Page[] };
      setPages(d.pages.filter((p) => p.kind !== "database"));
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    void loadPages();
  }, []);

  const pageTitle = (id?: string | null) => (id ? pages.find((p) => p.id === id)?.title ?? null : null);

  async function create() {
    if (!term.trim() || !definition.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/glossary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ term, definition }) });
      setTerm(""); setDefinition(""); setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/glossary/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  // existingId 가 있으면 갱신, 없으면 생성한다. (늘 POST 하던 시절엔 duplicate/conflict
  // 제안을 수락할 때마다 같은 용어가 하나 더 쌓였다 — 전수조사 D18)
  function acceptProposal(p: Proposal, sourcePageId: string) {
    return p.existingId
      ? fetch(`/api/glossary/${p.existingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ definition: p.definition }),
        })
      : fetch("/api/glossary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ term: p.term, definition: p.definition, sourcePageId }),
        });
  }

  if (list === null) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>용어집 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{list.length}</span></span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setExtractOpen((v) => !v)}><Icon name="doc" size={15} /> 문서에서 추출</button>
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 용어 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              {/* 빈 상태의 '첫 용어 추가' 로 열었을 때 바로 입력할 수 있게 */}
              <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="용어 (예: 워크스페이스)" style={inp} />
              <textarea value={definition} onChange={(e) => setDefinition(e.target.value)} placeholder="정의" rows={2} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !term.trim() || !definition.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}
          {extractOpen && (
            <ExtractPanel<Proposal>
              label="문서에서 용어 추출 (AI)"
              endpoint="/api/glossary/extract"
              runningText="문서를 읽고 용어를 정리하는 중입니다(수십 초 걸릴 수 있어요)."
              emptyText="추출된 용어가 없습니다."
              keyOf={(p) => p.term}
              renderProposal={(p) => (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-strong)" }}>{p.term}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 2, lineHeight: 1.55 }}>{p.definition}</div>
                  {p.status === "conflict" && p.existingDefinition && (
                    <div style={{ fontSize: 12, color: "#E0900F", marginTop: 4 }}>기존: {p.existingDefinition}</div>
                  )}
                </>
              )}
              onAccept={acceptProposal}
              onAccepted={load}
            />
          )}
          {list.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="tag" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>용어가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>같은 말을 서로 다르게 쓰기 시작하면 되돌리기 어렵습니다. 직접 적어도 되고, 이미 쓴 문서가 있으면 거기서 뽑아 올 수도 있어요.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button style={primary} onClick={() => setOpen(true)}>첫 용어 추가</button>
                <button className="ws-btn-soft" onClick={() => setExtractOpen(true)}><Icon name="doc" size={15} /> 문서에서 추출</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {list.map((t) => (
                <div key={t.id} style={{ display: "flex", gap: 12, padding: "12px 14px", border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>{t.term}</div>
                    <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 3, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{t.definition}</div>
                    {t.sourcePageId && pageTitle(t.sourcePageId) && (
                      <a href={`/p/${t.sourcePageId}`} style={sourceChip}>
                        <Icon name="doc" size={11} /> 출처: {pageTitle(t.sourcePageId)}
                      </a>
                    )}
                  </div>
                  <button className="ws-btn-soft" disabled={busy} onClick={() => remove(t.id)} title="삭제" style={{ flex: "0 0 auto", alignSelf: "flex-start" }}><Icon name="close" size={14} /></button>
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
const sourceChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, marginTop: 7, fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)", textDecoration: "none", border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "2px 9px" };

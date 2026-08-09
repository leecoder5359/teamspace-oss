"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* 용어집(glossary) surface — 도메인 용어. /api/glossary. 제품 공통(프로젝트 무관). */

type Term = { id: string; term: string; definition: string; sourcePageId?: string | null };
type Page = { id: string; title: string; kind: string };
type ProposalStatus = "new" | "duplicate" | "conflict";
type Proposal = { term: string; definition: string; status: ProposalStatus; existingId?: string; existingDefinition?: string };

const STATUS_BADGE: Record<ProposalStatus, { label: string; color: string }> = {
  new: { label: "신규", color: "var(--color-primary)" },
  conflict: { label: "모순", color: "#E0900F" },
  duplicate: { label: "중복", color: "var(--text-disabled)" },
};

export default function GlossarySurface() {
  const [list, setList] = useState<Term[] | null>(null);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [definition, setDefinition] = useState("");
  const [busy, setBusy] = useState(false);

  // 문서에서 추출
  const [extractOpen, setExtractOpen] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageId, setPageId] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [extractErr, setExtractErr] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

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

  async function toggleExtract() {
    const next = !extractOpen;
    setExtractOpen(next);
    if (next && pages.length === 0) await loadPages();
  }

  async function runExtract() {
    if (!pageId || extracting) return;
    setExtracting(true);
    setProposals(null);
    setExtractErr(null);
    setAccepted(new Set());
    try {
      const res = await fetch("/api/glossary/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string; proposals?: Proposal[] };
      if (!res.ok || !d.ok) setExtractErr(d.error ?? "추출에 실패했습니다.");
      else setProposals(d.proposals ?? []);
    } catch {
      setExtractErr("추출 중 오류가 발생했습니다.");
    } finally {
      setExtracting(false);
    }
  }

  async function accept(p: Proposal) {
    // 종전엔 fetch 전에 '추가됨' 배지를 붙이고 응답을 안 봐서, 실패해도 성공처럼 보였다.
    // 또 existingId 를 무시하고 늘 POST 해서 duplicate/conflict 제안을 수락하면 같은
    // 용어가 하나 더 쌓였다 — API 도 프론트 타입도 existingId 를 갖고 있었는데
    // 아무도 안 썼다(전수조사 D18). 이제 있으면 갱신, 없으면 생성한다.
    const res = p.existingId
      ? await fetch(`/api/glossary/${p.existingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ definition: p.definition }),
        })
      : await fetch("/api/glossary", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ term: p.term, definition: p.definition, sourcePageId: pageId }),
        });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setExtractErr(d.error ?? `'${p.term}' 를 반영하지 못했습니다.`);
      return;
    }
    setExtractErr(null);
    setAccepted((prev) => new Set(prev).add(p.term));
    await load();
  }

  if (list === null) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>용어집 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{list.length}</span></span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={toggleExtract}><Icon name="doc" size={15} /> 문서에서 추출</button>
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 용어 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="용어 (예: 워크스페이스)" style={inp} />
              <textarea value={definition} onChange={(e) => setDefinition(e.target.value)} placeholder="정의" rows={2} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !term.trim() || !definition.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}
          {extractOpen && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 8 }}>문서에서 용어 추출 (AI)</div>
              <div style={{ display: "flex", gap: 8 }}>
                <select value={pageId} onChange={(e) => setPageId(e.target.value)} style={{ ...inp, flex: 1, cursor: "pointer" }}>
                  <option value="">문서 선택…</option>
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>{p.title || "제목 없음"}</option>
                  ))}
                </select>
                <button style={primary} disabled={!pageId || extracting} onClick={runExtract}>
                  {extracting ? "추출 중…" : "추출"}
                </button>
              </div>
              {extracting && <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>문서를 읽고 용어를 정리하는 중입니다(수십 초 걸릴 수 있어요).</p>}
              {extractErr && <p style={{ fontSize: 12.5, color: "#D14343", marginTop: 8 }}>{extractErr}</p>}

              {proposals && proposals.length === 0 && !extracting && (
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 10 }}>추출된 용어가 없습니다.</p>
              )}
              {proposals && proposals.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
                  {proposals.map((p, i) => {
                    const badge = STATUS_BADGE[p.status];
                    const done = accepted.has(p.term);
                    return (
                      <div key={`${p.term}-${i}`} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", border: "1px solid var(--border-subtle)", borderRadius: 9, background: "var(--surface-muted, transparent)" }}>
                        <span style={{ flex: "0 0 auto", fontSize: 10.5, fontWeight: 700, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 999, padding: "1px 7px", marginTop: 2 }}>{badge.label}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-strong)" }}>{p.term}</div>
                          <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 2, lineHeight: 1.55 }}>{p.definition}</div>
                          {p.status === "conflict" && p.existingDefinition && (
                            <div style={{ fontSize: 12, color: "#E0900F", marginTop: 4 }}>기존: {p.existingDefinition}</div>
                          )}
                        </div>
                        {p.status === "duplicate" ? (
                          <span style={{ flex: "0 0 auto", fontSize: 12, color: "var(--text-disabled)", alignSelf: "center" }}>있음</span>
                        ) : done ? (
                          <span style={{ flex: "0 0 auto", fontSize: 12, color: "var(--color-primary)", fontWeight: 600, alignSelf: "center" }}>추가됨</span>
                        ) : (
                          <button className="ws-btn-soft" style={{ flex: "0 0 auto", alignSelf: "center" }} onClick={() => accept(p)}>
                            {p.status === "conflict" ? "새로 추가" : "추가"}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {list.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="tag" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>용어가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>도메인 용어를 정리해 두면 온보딩이 쉬워져요.</div>
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

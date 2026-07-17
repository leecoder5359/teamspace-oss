"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* 데이터 모델(datamodel) surface — 엔티티·필드. /api/entities. 제품 공통. */

type Entity = { id: string; name: string; description: string | null; fields: string | null; sourcePageId?: string | null };
type Page = { id: string; title: string; kind: string };
type ProposalStatus = "new" | "duplicate" | "conflict";
type Proposal = { name: string; description: string; fields: string; status: ProposalStatus; existingId?: string; existingDescription?: string };

const STATUS_BADGE: Record<ProposalStatus, { label: string; color: string }> = {
  new: { label: "신규", color: "var(--color-primary)" },
  conflict: { label: "모순", color: "#E0900F" },
  duplicate: { label: "중복", color: "var(--text-disabled)" },
};

export default function DataModelSurface() {
  const [list, setList] = useState<Entity[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState("");
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
    const data = (await (await fetch("/api/entities", { cache: "no-store" })).json()) as { entities: Entity[] };
    setList(data.entities);
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
    if (!name.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/entities", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, fields }) });
      setName(""); setDescription(""); setFields(""); setOpen(false);
      await load();
    } finally { setBusy(false); }
  }
  async function remove(id: string) { setBusy(true); try { await fetch(`/api/entities/${id}`, { method: "DELETE" }); await load(); } finally { setBusy(false); } }

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
      const res = await fetch("/api/entities/extract", {
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
    setAccepted((prev) => new Set(prev).add(p.name));
    await fetch("/api/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: p.name, description: p.description, fields: p.fields, sourcePageId: pageId }),
    });
    await load();
  }

  if (list === null) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>데이터 모델 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{list.length}</span></span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={toggleExtract}><Icon name="doc" size={15} /> 문서에서 추출</button>
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 엔티티 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="엔티티 이름 (예: Project)" style={inp} />
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="설명" style={{ ...inp, marginTop: 8 }} />
              <textarea value={fields} onChange={(e) => setFields(e.target.value)} placeholder={"필드 (한 줄에 하나)\nname: string — 이름\nstatus: enum — 상태"} rows={4} style={{ ...inp, marginTop: 8, resize: "vertical", fontFamily: "var(--font-mono)" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !name.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}
          {extractOpen && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 8 }}>문서에서 엔티티 추출 (AI)</div>
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
              {extracting && <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>문서를 읽고 엔티티를 정리하는 중입니다(수십 초 걸릴 수 있어요).</p>}
              {extractErr && <p style={{ fontSize: 12.5, color: "#D14343", marginTop: 8 }}>{extractErr}</p>}

              {proposals && proposals.length === 0 && !extracting && (
                <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 10 }}>추출된 엔티티가 없습니다.</p>
              )}
              {proposals && proposals.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
                  {proposals.map((p, i) => {
                    const badge = STATUS_BADGE[p.status];
                    const done = accepted.has(p.name);
                    return (
                      <div key={`${p.name}-${i}`} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", border: "1px solid var(--border-subtle)", borderRadius: 9 }}>
                        <span style={{ flex: "0 0 auto", fontSize: 10.5, fontWeight: 700, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 999, padding: "1px 7px", marginTop: 2 }}>{badge.label}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-strong)" }}>{p.name}</div>
                          {p.description && <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 2, lineHeight: 1.55 }}>{p.description}</div>}
                          {p.fields && <pre style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-body)", margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{p.fields}</pre>}
                          {p.status === "conflict" && p.existingDescription && (
                            <div style={{ fontSize: 12, color: "#E0900F", marginTop: 4 }}>기존: {p.existingDescription}</div>
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
              <span style={{ color: "var(--text-muted)" }}><Icon name="table" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>엔티티가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>핵심 도메인 엔티티와 필드를 정리하세요.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {list.map((e) => (
                <div key={e.id} style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ display: "flex", color: "var(--color-primary)" }}><Icon name="table" size={16} /></span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)" }}>{e.name}</span>
                    <span style={{ flex: 1 }} />
                    <button className="ws-btn-soft" disabled={busy} onClick={() => remove(e.id)} title="삭제"><Icon name="close" size={14} /></button>
                  </div>
                  {e.description && <p style={{ fontSize: 13, color: "var(--text-sub)", margin: "6px 0 0" }}>{e.description}</p>}
                  {e.fields && <pre style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, color: "var(--text-body)", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "10px 12px", marginTop: 10, whiteSpace: "pre-wrap" }}>{e.fields}</pre>}
                  {e.sourcePageId && pageTitle(e.sourcePageId) && (
                    <a href={`/p/${e.sourcePageId}`} style={sourceChip}>
                      <Icon name="doc" size={11} /> 출처: {pageTitle(e.sourcePageId)}
                    </a>
                  )}
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
const sourceChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 4, marginTop: 10, fontSize: 11.5, fontWeight: 600, color: "var(--text-muted)", textDecoration: "none", border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "2px 9px" };

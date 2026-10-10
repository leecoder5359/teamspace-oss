"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";
import ExtractPanel from "./ExtractPanel";
import { getPages } from "@/lib/pagesClient";

/* 데이터 모델(datamodel) surface — 엔티티·필드. /api/entities. 제품 공통. */

type Entity = { id: string; name: string; description: string | null; fields: string | null; sourcePageId?: string | null };
type Page = { id: string; title: string; kind: string };
type Proposal = { name: string; description: string; fields: string; status: "new" | "duplicate" | "conflict"; existingId?: string; existingDescription?: string };

export default function DataModelSurface() {
  const [list, setList] = useState<Entity[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState("");
  const [busy, setBusy] = useState(false);

  const [extractOpen, setExtractOpen] = useState(false);
  // pages 는 추출 패널이 아니라 목록의 '출처' 칩(제목 표시)에 쓴다 — 패널은 스스로 문서를 읽어온다.
  const [pages, setPages] = useState<Page[]>([]);

  async function load() {
    const data = (await (await fetch("/api/entities", { cache: "no-store" })).json()) as { entities: Entity[] };
    setList(data.entities);
  }
  async function loadPages() {
    const r = await getPages();
    if (r.ok) {
      const d = r.data as { pages: Page[] };
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

  // 용어집과 같은 규칙 — existingId 가 있으면 새로 만들지 않고 갱신한다(중복 엔티티 방지, 전수조사 D18).
  function acceptProposal(p: Proposal, sourcePageId: string) {
    return p.existingId
      ? fetch(`/api/entities/${p.existingId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ description: p.description, fields: p.fields }),
        })
      : fetch("/api/entities", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: p.name, description: p.description, fields: p.fields, sourcePageId }),
        });
  }

  if (list === null) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>데이터 모델 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{list.length}</span></span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setExtractOpen((v) => !v)}><Icon name="doc" size={15} /> 문서에서 추출</button>
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 엔티티 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              {/* 빈 상태의 '첫 엔티티 추가' 로 열었을 때 바로 입력할 수 있게 */}
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="엔티티 이름 (예: Project)" style={inp} />
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
            <ExtractPanel<Proposal>
              label="문서에서 엔티티 추출 (AI)"
              endpoint="/api/entities/extract"
              runningText="문서를 읽고 엔티티를 정리하는 중입니다(수십 초 걸릴 수 있어요)."
              emptyText="추출된 엔티티가 없습니다."
              keyOf={(p) => p.name}
              renderProposal={(p) => (
                <>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-strong)" }}>{p.name}</div>
                  {p.description && <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 2, lineHeight: 1.55 }}>{p.description}</div>}
                  {p.fields && <pre style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-body)", margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{p.fields}</pre>}
                  {p.status === "conflict" && p.existingDescription && (
                    <div style={{ fontSize: 12, color: "#E0900F", marginTop: 4 }}>기존: {p.existingDescription}</div>
                  )}
                </>
              )}
              onAccept={acceptProposal}
              onAccepted={load}
            />
          )}
          {list.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="table" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>엔티티가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>도메인의 뼈대가 되는 개체와 필드를 적어 두는 자리입니다. 직접 적어도 되고, 설계 문서가 있으면 거기서 뽑아 올 수도 있어요.</div>
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button style={primary} onClick={() => setOpen(true)}>첫 엔티티 추가</button>
                <button className="ws-btn-soft" onClick={() => setExtractOpen(true)}><Icon name="doc" size={15} /> 문서에서 추출</button>
              </div>
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

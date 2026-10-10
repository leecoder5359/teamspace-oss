"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* 변경 이력(changelog) surface — 릴리스 노트. /api/changelog. 제품 공통. */

type Entry = { id: string; projectId: string | null; version: string | null; title: string; body: string | null; releasedAt: string };
type Proj = { id: string; name: string; archivedAt: string | null };

export default function ChangelogSurface() {
  const [list, setList] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [projects, setProjects] = useState<Proj[]>([]);
  // 필터: "" = 전체, "none" = 프로젝트 없음(공용), 그 외 = 프로젝트 id
  const [filter, setFilter] = useState("");
  const [formProject, setFormProject] = useState("");

  async function load(f = filter) {
    const res = await fetch(`/api/changelog${f ? `?project=${encodeURIComponent(f)}` : ""}`, { cache: "no-store" });
    const data = (await res.json()) as { entries: Entry[] };
    setList(data.entries);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    (async () => {
      try {
        // 칩 라벨은 보관 프로젝트 항목에도 이름이 떠야 해서 보관 포함으로 받는다(선택지는 아래에서 활성만)
        const res = await fetch("/api/projects?archived=all", { cache: "no-store" });
        const j = (await res.json()) as { projects?: (Omit<Proj, "archivedAt"> & { archivedAt?: string | null })[] };
        if (Array.isArray(j.projects)) setProjects(j.projects.map((p) => ({ id: p.id, name: p.name, archivedAt: p.archivedAt ?? null })));
      } catch {
        /* 칩·필터만 비는 것 — 목록은 그대로 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await fetch("/api/changelog", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version, title, body, projectId: formProject || null }) });
      setVersion(""); setTitle(""); setBody(""); setFormProject(""); setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/changelog/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (list === null) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>변경 이력 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{list.length}</span></span>
        <select className="ws-db-filter" value={filter} onChange={(e) => { setFilter(e.target.value); void load(e.target.value); }} aria-label="프로젝트">
          <option value="">전체</option>
          {projects.filter((p) => !p.archivedAt || p.id === filter).map((p) => <option key={p.id} value={p.id}>{p.archivedAt ? `${p.name} (보관)` : p.name}</option>)}
          <option value="none">프로젝트 없음</option>
        </select>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}><Icon name="plus" size={15} /> 릴리스 추가</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 56px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          {open && (
            <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 8 }}>
                {/* 빈 상태의 '첫 릴리스 추가' 로 열었을 때 바로 입력할 수 있게 */}
                <input autoFocus value={version} onChange={(e) => setVersion(e.target.value)} placeholder="버전 (예: v1.2.0)" style={{ ...inp, flex: "0 0 160px" }} />
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목" style={{ ...inp, flex: 1 }} />
              </div>
              <select className="ws-db-filter" value={formProject} onChange={(e) => setFormProject(e.target.value)} aria-label="프로젝트" style={{ marginTop: 8 }}>
                <option value="">프로젝트 없음</option>
                {projects.filter((p) => !p.archivedAt || p.id === formProject).map((p) => <option key={p.id} value={p.id}>{p.archivedAt ? `${p.name} (보관)` : p.name}</option>)}
              </select>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="변경 내용" rows={3} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primary} disabled={busy || !title.trim()} onClick={create}>저장</button>
              </div>
            </div>
          )}
          {list.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="refresh" size={32} /></span>
              <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>릴리스 노트가 없어요</div>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>배포할 때마다 버전과 바뀐 내용을 남기면, &ldquo;이거 언제부터 이랬죠?&rdquo; 에 답할 수 있는 기록이 됩니다.</div>
              <div style={{ marginTop: 14 }}>
                <button style={primary} onClick={() => setOpen(true)}>첫 릴리스 추가</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {list.map((e) => (
                <div key={e.id} style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {e.version && <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: "var(--color-primary)", background: "var(--color-primary-weak)", padding: "2px 8px", borderRadius: 6 }}>{e.version}</span>}
                    <span style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-strong)" }}>{e.title}</span>
                    {e.projectId && (
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-sub)", background: "var(--surface-sunken, var(--border-subtle))", padding: "2px 8px", borderRadius: 6 }}>
                        {projects.find((p) => p.id === e.projectId)?.name ?? "프로젝트"}
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{new Date(e.releasedAt).toLocaleDateString("ko-KR")}</span>
                    <button className="ws-btn-soft" disabled={busy} onClick={() => remove(e.id)} title="삭제"><Icon name="close" size={14} /></button>
                  </div>
                  {e.body && <p style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.6, margin: "10px 0 0", whiteSpace: "pre-wrap" }}>{e.body}</p>}
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

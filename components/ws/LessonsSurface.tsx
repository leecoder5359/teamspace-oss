"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* 레슨(팀 작업규칙) surface — /api/lessons.
   W3 메모리 일원화의 핵심 층: 여기 등록된 규칙은 모든 팀원·에이전트 세션에 자동 주입된다.
   목록·추가·수정·삭제 + 프로젝트 스코프 표시. */

type Lesson = {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  createdById: string | null;
  updatedAt: string;
};

type Proposal = {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  proposedByName: string;
  createdAt: string;
};

const REAL = (p: string) => p && p !== "__none__";

export default function LessonsSurface({ project }: { project: string }) {
  const [list, setList] = useState<Lesson[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scopeProject, setScopeProject] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Proposal[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  const load = useCallback(async () => {
    const qs = REAL(project) ? `?projectId=${project}` : "";
    const [res, pRes, wRes] = await Promise.all([
      fetch(`/api/lessons${qs}`, { cache: "no-store" }),
      fetch("/api/proposals?status=pending", { cache: "no-store" }),
      fetch("/api/workspace", { cache: "no-store" }),
    ]);
    if (res.ok) setList(((await res.json()) as { lessons: Lesson[] }).lessons);
    if (pRes.ok) setPending(((await pRes.json()) as { proposals: Proposal[] }).proposals);
    if (wRes.ok) setIsAdmin(((await wRes.json()) as { role: string | null }).role === "admin");
  }, [project]);

  async function review(id: string, action: "approve" | "reject") {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(`/api/proposals/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function create() {
    if (!title.trim() || !body.trim() || busy) return;
    setBusy(true);
    try {
      await fetch("/api/lessons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          projectId: scopeProject && REAL(project) ? project : undefined,
        }),
      });
      setTitle("");
      setBody("");
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editId || !editTitle.trim() || !editBody.trim() || busy) return;
    setBusy(true);
    try {
      await fetch(`/api/lessons/${editId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: editTitle.trim(), body: editBody.trim() }),
      });
      setEditId(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("이 규칙을 삭제할까요? 다음 세션부터 주입에서 빠집니다.")) return;
    setBusy(true);
    try {
      await fetch(`/api/lessons/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return (list ?? []).filter(
      (l) => !ql || l.title.toLowerCase().includes(ql) || l.body.toLowerCase().includes(ql),
    );
  }, [list, q]);

  if (list === null) return <div style={{ padding: 40 }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="ws-filterbar">
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>
          팀 작업규칙 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{rows.length}</span>
        </span>
        <div className="ws-search" style={{ flex: "0 1 220px" }}>
          <span style={{ display: "flex", color: "var(--text-muted)" }}><Icon name="search" size={14} /></span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="규칙 검색" aria-label="규칙 검색" />
        </div>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => setOpen((v) => !v)}>
          <Icon name="plus" size={14} /> 규칙 추가
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px 60px" }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px" }}>
            여기 등록된 규칙은 <b>모든 팀원·에이전트의 세션 시작 시 자동 주입</b>됩니다. 팀이 지켜야 할 규범·교훈을
            승격하는 자리입니다. (CLI: <code>pnpm ws lesson add</code> · MCP: <code>lesson_add</code>)
          </p>

          {pending.length > 0 && (
            <div style={{ ...card, borderColor: "var(--color-primary)", marginBottom: 14 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--color-primary)" }}>
                📥 승격 대기 제안 {pending.length}건 {isAdmin ? "" : "(승인은 admin)"}
              </div>
              {pending.map((pr) => (
                <div key={pr.id} style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 8, borderTop: "1px solid var(--border-subtle)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={badge}>{pr.kind === "lesson" ? "규칙" : "결정"}</span>
                    <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)", flex: 1 }}>{pr.title}</span>
                    <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{pr.proposedByName}</span>
                    {isAdmin && (
                      <>
                        <button className="ws-btn-soft" disabled={busy} onClick={() => void review(pr.id, "approve")}>승인</button>
                        <button className="ws-btn-soft" disabled={busy} onClick={() => void review(pr.id, "reject")} style={{ color: "#C0392B" }}>거부</button>
                      </>
                    )}
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--text-body)", whiteSpace: "pre-wrap" }}>{pr.body}</div>
                </div>
              ))}
            </div>
          )}

          {open && (
            <div style={card}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="규칙 제목 (예: 태스크는 claim으로 잡는다)" style={inp} />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="본문 — 왜 필요한지, 어떻게 적용하는지까지"
                rows={3}
                style={{ ...inp, resize: "vertical", fontFamily: "inherit" }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {REAL(project) && (
                  <label style={{ fontSize: 12.5, color: "var(--text-muted)", display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={scopeProject} onChange={(e) => setScopeProject(e.target.checked)} />
                    이 프로젝트에만 적용
                  </label>
                )}
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primaryBtn} onClick={() => void create()} disabled={busy || !title.trim() || !body.trim()}>등록</button>
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="ws-empty-hint">아직 규칙이 없습니다. 팀이 알아야 할 규범을 추가해 보세요.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((l) =>
                editId === l.id ? (
                  <div key={l.id} style={card}>
                    <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={inp} />
                    <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={3} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                      <button className="ws-btn-soft" onClick={() => setEditId(null)}>취소</button>
                      <button style={primaryBtn} onClick={() => void saveEdit()} disabled={busy}>저장</button>
                    </div>
                  </div>
                ) : (
                  <div key={l.id} style={{ ...card, gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "flex", color: "var(--color-primary)" }}><Icon name="flag" size={15} /></span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)", flex: 1 }}>{l.title}</span>
                      {l.projectId ? (
                        <span style={badge}>프로젝트</span>
                      ) : (
                        <span style={{ ...badge, background: "var(--surface-sunken)", color: "var(--text-muted)" }}>전역</span>
                      )}
                      <button className="ws-icon-btn" title="수정" onClick={() => { setEditId(l.id); setEditTitle(l.title); setEditBody(l.body); }}>
                        <Icon name="settings" size={14} />
                      </button>
                      <button className="ws-icon-btn" title="삭제" onClick={() => void remove(l.id)}>
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--text-body)", whiteSpace: "pre-wrap", lineHeight: 1.65 }}>{l.body}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>수정 {new Date(l.updatedAt).toLocaleString("ko-KR")}</div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const card: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: 12,
  border: "1px solid var(--border-subtle)", background: "var(--surface-card)", marginBottom: 4,
};
const inp: CSSProperties = {
  padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)",
  background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, width: "100%",
};
const primaryBtn: CSSProperties = {
  padding: "8px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer",
  border: "1px solid transparent", background: "var(--color-primary)", color: "#fff",
};
const badge: CSSProperties = {
  fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 7,
  background: "rgba(47,98,255,0.12)", color: "var(--color-primary)",
};

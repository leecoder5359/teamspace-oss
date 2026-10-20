"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* 레슨(팀 작업규칙) surface — /api/lessons.
   W3 메모리 일원화의 핵심 층: 여기 등록된 규칙은 모든 팀원·에이전트 세션에 자동 주입된다.
   목록·추가·수정·삭제 + 범위(개인·프로젝트·스택·전역)·주입 방식(필수·기본·필요할 때만) 표시와 변경. */

type Lesson = {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  stack?: string | null;
  personal?: boolean;
  mode?: Mode;
  /** 프롬프트 매칭 키워드 — 메시지에 있으면 UserPromptSubmit 훅이 주입 */
  keywords?: string[];
  createdById: string | null;
  updatedAt: string;
  /** 개인 레슨의 팀원 공개 여부(scope=mine) */
  sharedWithTeam?: boolean;
  copiedFromId?: string | null;
  /** 팀원에게서 가져온 복사본의 출처(scope=mine) — 원본이 지워졌으면 deleted */
  copiedFrom?: { id: string; authorName: string | null; deleted: boolean } | null;
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

type Mode = "required" | "default" | "ondemand";
const MODE_LABEL: Record<Mode, string> = { required: "필수", default: "기본", ondemand: "필요할 때만" };
const MODE_HINT: Record<Mode, string> = {
  required: "범위 안이면 항상 제목+요약으로 먼저 주입",
  default: "제목 먼저, 예산이 남으면 요약",
  ondemand: "세션 시작 주입에서 빠짐 — 메시지에 키워드가 나오면 주입, 그 밖엔 목록·검색·lesson_get 으로",
};
const MODES: Mode[] = ["required", "default", "ondemand"];

/** scope: team = 팀 레슨(개인 제외) · mine = 내 개인 레슨(/lessons 의 탭) */
export default function LessonsSurface({ project, scope = "team" }: { project: string; scope?: "team" | "mine" }) {
  const isMine = scope === "mine";
  const [list, setList] = useState<Lesson[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [scopeProject, setScopeProject] = useState(false);
  const [mode, setMode] = useState<Mode>("default");
  const [keywords, setKeywords] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editMode, setEditMode] = useState<Mode>("default");
  const [editKeywords, setEditKeywords] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [editPersonal, setEditPersonal] = useState(false);
  const [editWasPersonal, setEditWasPersonal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Proposal[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ scope });
    if (REAL(project)) qs.set("projectId", project);
    const [res, pRes, wRes] = await Promise.all([
      fetch(`/api/lessons?${qs}`, { cache: "no-store" }),
      // 승격 대기 제안은 팀 레슨 탭에서만
      scope === "team" ? fetch("/api/proposals?status=pending", { cache: "no-store" }) : null,
      fetch("/api/workspace", { cache: "no-store" }),
    ]);
    if (res.ok) setList(((await res.json()) as { lessons: Lesson[] }).lessons);
    if (pRes?.ok) setPending(((await pRes.json()) as { proposals: Proposal[] }).proposals);
    if (wRes.ok) setIsAdmin(((await wRes.json()) as { role: string | null }).role === "admin");
  }, [project, scope]);

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
    setErr(null);
    try {
      const res = await fetch("/api/lessons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          projectId: !isMine && scopeProject && REAL(project) ? project : undefined,
          // 개인 레슨은 내 레슨 탭에서만 만든다
          ...(isMine ? { personal: true } : {}),
          mode,
          ...(keywords.trim() ? { keywords } : {}),
        }),
      });
      if (!res.ok) {
        setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "등록하지 못했습니다.");
        return;
      }
      setTitle("");
      setKeywords("");
      setBody("");
      setMode("default");
      setOpen(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editId || !editTitle.trim() || !editBody.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/lessons/${editId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim(),
          body: editBody.trim(),
          mode: editMode,
          keywords: editKeywords,
          // 개인 체크를 바꿨을 때만 범위를 건드린다(끄면 전역으로)
          ...(editPersonal !== editWasPersonal ? { personal: editPersonal } : {}),
        }),
      });
      if (!res.ok) {
        setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "저장하지 못했습니다.");
        return;
      }
      setEditId(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleShared(l: Lesson) {
    setBusy(true);
    try {
      await fetch(`/api/lessons/${l.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sharedWithTeam: l.sharedWithTeam === false }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function promote(l: Lesson) {
    const target = REAL(project) ? "이 프로젝트" : "전역";
    if (!window.confirm(`"${l.title}" 을(를) ${target} 팀 레슨으로 올릴까요? 범위 안의 모든 세션에 주입됩니다.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lessons/${l.id}/promote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: REAL(project) ? project : null }),
      });
      if (!res.ok) setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "올리지 못했습니다.");
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
          {isMine ? "내 레슨" : "팀 작업규칙"} <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{rows.length}</span>
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
          {isMine ? (
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px" }}>
              나와 내가 발급한 에이전트 토큰의 세션에만 주입됩니다. 공개된 것은 팀원이 둘러보고 가져갈 수 있습니다(주입은 안 됨).
            </p>
          ) : (
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 14px" }}>
              여기 등록된 규칙은 <b>모든 팀원·에이전트의 세션 시작 시 자동 주입</b>됩니다. 팀이 지켜야 할 규범·교훈을
              승격하는 자리입니다. (CLI: <code>pnpm ws lesson add</code> · MCP: <code>lesson_add</code>)
            </p>
          )}

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
              {/* 빈 상태의 '첫 규칙 추가' 로 열었을 때 바로 입력할 수 있게 */}
              <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="규칙 제목 (예: 태스크는 claim으로 잡는다)" style={inp} />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="본문 — 왜 필요한지, 어떻게 적용하는지까지"
                rows={3}
                style={{ ...inp, resize: "vertical", fontFamily: "inherit" }}
              />
              <input
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="키워드 (쉼표로 구분, 예: prisma, 마이그레이션) — 메시지에 나오면 이 규칙을 넣습니다"
                aria-label="키워드"
                style={inp}
              />
              {err && <div style={{ fontSize: 12.5, color: "var(--color-danger)" }}>{err}</div>}
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                {!isMine && REAL(project) && (
                  <label style={{ fontSize: 12.5, color: "var(--text-muted)", display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={scopeProject} onChange={(e) => setScopeProject(e.target.checked)} />
                    이 프로젝트에만 적용
                  </label>
                )}
                <select className="ws-db-filter" value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="주입 방식" title={MODE_HINT[mode]}>
                  {MODES.map((m) => (
                    <option key={m} value={m}>주입: {MODE_LABEL[m]}</option>
                  ))}
                </select>
                <span style={{ flex: 1 }} />
                <button className="ws-btn-soft" onClick={() => setOpen(false)}>취소</button>
                <button style={primaryBtn} onClick={() => void create()} disabled={busy || !title.trim() || !body.trim()}>등록</button>
              </div>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="ws-docs-empty">
              <span style={{ color: "var(--text-muted)" }}><Icon name="flag" size={32} /></span>
              {list.length > 0 ? (
                <>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>검색어에 맞는 규칙이 없어요</div>
                  <div style={{ fontSize: "var(--ds-fs-md)", color: "var(--text-sub)", marginTop: 6 }}>등록된 규칙 {list.length}건이 검색어에 걸러졌습니다.</div>
                  <div style={{ marginTop: 14 }}>
                    <button className="ws-btn-soft" onClick={() => setQ("")}>검색어 지우기</button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>팀 작업규칙이 없어요</div>
                  <div style={{ fontSize: "var(--ds-fs-md)", color: "var(--text-sub)", marginTop: 6 }}>
                    규칙이 하나도 없으면 세션 시작 시 주입할 것도 없습니다. 반복해서 설명하게 되는 규범을 하나씩 승격하세요.
                    (CLI: <code>pnpm ws lesson add</code>)
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <button style={primaryBtn} onClick={() => setOpen(true)}>첫 규칙 추가</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((l) =>
                editId === l.id ? (
                  <div key={l.id} style={card}>
                    <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} style={inp} />
                    <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={3} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
                    <input
                      value={editKeywords}
                      onChange={(e) => setEditKeywords(e.target.value)}
                      placeholder="키워드 (쉼표로 구분) — 메시지에 나오면 이 규칙을 넣습니다"
                      aria-label="키워드"
                      style={inp}
                    />
                    {err && <div style={{ fontSize: 12.5, color: "var(--color-danger)" }}>{err}</div>}
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                      <label style={{ fontSize: 12.5, color: "var(--text-muted)", display: "inline-flex", gap: 6, alignItems: "center" }} title="나와 내가 발급한 에이전트 토큰의 세션에만 주입. 끄면 전역">
                        <input type="checkbox" checked={editPersonal} onChange={(e) => setEditPersonal(e.target.checked)} />
                        나에게만(개인)
                      </label>
                      <select className="ws-db-filter" value={editMode} onChange={(e) => setEditMode(e.target.value as Mode)} aria-label="주입 방식" title={MODE_HINT[editMode]}>
                        {MODES.map((m) => (
                          <option key={m} value={m}>주입: {MODE_LABEL[m]}</option>
                        ))}
                      </select>
                      <span style={{ flex: 1 }} />
                      <button className="ws-btn-soft" onClick={() => setEditId(null)}>취소</button>
                      <button style={primaryBtn} onClick={() => void saveEdit()} disabled={busy}>저장</button>
                    </div>
                  </div>
                ) : (
                  <div key={l.id} style={{ ...card, gap: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ display: "flex", color: "var(--color-primary)" }}><Icon name="flag" size={15} /></span>
                      <span style={{ fontSize: "var(--ds-fs-base)", fontWeight: 700, color: "var(--text-strong)", flex: 1 }}>{l.title}</span>
                      {l.mode && l.mode !== "default" && (
                        <span
                          style={l.mode === "required" ? badge : { ...badge, background: "var(--surface-sunken)", color: "var(--text-muted)" }}
                          title={MODE_HINT[l.mode]}
                        >
                          {MODE_LABEL[l.mode]}
                        </span>
                      )}
                      {l.personal ? (
                        <span style={badge} title="나와 내가 발급한 에이전트 토큰의 세션에만 주입">개인</span>
                      ) : l.projectId ? (
                        <span style={badge}>프로젝트</span>
                      ) : l.stack ? (
                        <span style={badge} title="이 스택을 쓰는 프로젝트 세션에만 주입">스택: {l.stack}</span>
                      ) : (
                        <span style={{ ...badge, background: "var(--surface-sunken)", color: "var(--text-muted)" }}>전역</span>
                      )}
                      {isMine && l.sharedWithTeam === false && (
                        <span style={{ ...badge, background: "var(--surface-sunken)", color: "var(--text-muted)" }}>팀원에게 숨김</span>
                      )}
                      {isMine && l.copiedFrom && (
                        <span style={l.copiedFrom.deleted ? { ...badge, background: "var(--surface-sunken)", color: "var(--text-muted)" } : badge}>
                          {l.copiedFrom.deleted ? "원본 삭제됨" : l.copiedFrom.authorName ? `${l.copiedFrom.authorName} 님에게서 가져옴` : "가져옴"}
                        </span>
                      )}
                      {isMine && (
                        <button className="ws-btn-soft" disabled={busy} onClick={() => void toggleShared(l)}>
                          {l.sharedWithTeam === false ? "팀원에게 공개" : "팀원에게 숨기기"}
                        </button>
                      )}
                      {isMine && isAdmin && (
                        <button className="ws-btn-soft" disabled={busy} onClick={() => void promote(l)}>팀 레슨으로 올리기</button>
                      )}
                      <button className="ws-icon-btn" title="수정" onClick={() => {
                          setEditId(l.id);
                          setEditTitle(l.title);
                          setEditBody(l.body);
                          setEditMode(l.mode ?? "default");
                          setEditKeywords((l.keywords ?? []).join(", "));
                          setErr(null);
                          setEditPersonal(!!l.personal);
                          setEditWasPersonal(!!l.personal);
                        }}
                      >
                        <Icon name="settings" size={14} />
                      </button>
                      <button className="ws-icon-btn" title="삭제" onClick={() => void remove(l.id)}>
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                    <div style={{ fontSize: "var(--ds-fs-md)", color: "var(--text-body)", whiteSpace: "pre-wrap", lineHeight: 1.65 }}>{l.body}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                      수정 {new Date(l.updatedAt).toLocaleString("ko-KR")}
                      {l.keywords?.length ? <span title="메시지에 이 단어가 나오면 주입"> · 키워드: {l.keywords.join(", ")}</span> : null}
                    </div>
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

export const card: CSSProperties = {
  display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", borderRadius: "var(--ds-r-md)",
  border: "1px solid var(--border-subtle)", background: "var(--surface-card)", marginBottom: 4,
};
const inp: CSSProperties = {
  padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)",
  background: "var(--surface-card)", color: "var(--text-strong)", fontSize: "var(--ds-fs-md)", width: "100%",
};
export const primaryBtn: CSSProperties = {
  padding: "8px 16px", borderRadius: 9, fontSize: "var(--ds-fs-md)", fontWeight: 600, cursor: "pointer",
  border: "1px solid transparent", background: "var(--color-primary)", color: "#fff",
};
export const badge: CSSProperties = {
  fontSize: "var(--ds-fs-xs)", fontWeight: 700, padding: "2px 8px", borderRadius: 7,
  background: "rgba(47,98,255,0.12)", color: "var(--color-primary)",
};

"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { Avatar, AvatarStack, colorFor } from "./ui";
import { Icon } from "./icons";
import type { ProjectStat } from "@/lib/projects";
import { repoLabel } from "@/lib/repo";

/* =====================================================================
   프로젝트 개요 화면 — 워크스페이스의 프로젝트를 카드 그리드로.
   각 카드 지표(열린 태스크·지연/임박·상태 미니바·참여자·문서 수)는 프로젝트에
   소속된 태스크 보드(database 페이지)의 DbRow에서 서버가 파생(lib/projects).
   카드 클릭 → 해당 프로젝트의 첫 보드로 이동. "새 프로젝트"로 생성.
   ===================================================================== */

const COLOR_KEYS = ["blue", "green", "purple", "orange", "red", "gray"] as const;

type MemberLite = { id: string; name: string };

export default function Projects({
  initialProjects,
  members,
}: {
  initialProjects: ProjectStat[];
  members: MemberLite[];
}) {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectStat[]>(initialProjects);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", short: "", color: "blue", leadId: "", description: "", repoUrl: "", repoPath: "" });
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const EMPTY = { name: "", short: "", color: "blue", leadId: "", description: "", repoUrl: "", repoPath: "" };

  function flashErr(msg: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    setError(msg);
    timerRef.current = setTimeout(() => setError(null), 3500);
  }

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY);
    setFormOpen(true);
  }

  function openEdit(p: ProjectStat) {
    setEditingId(p.id);
    setForm({
      name: p.name,
      short: p.short ?? "",
      color: p.color,
      leadId: p.lead?.id ?? "",
      description: p.description ?? "",
      repoUrl: p.repoUrl ?? "",
      repoPath: p.repoPath ?? "",
    });
    setFormOpen(true);
  }

  function closeForm() {
    setFormOpen(false);
    setEditingId(null);
    setForm(EMPTY);
  }

  function openBoard(p: ProjectStat) {
    if (p.boardPageId) router.push(`/p/${p.boardPageId}?view=kanban`);
  }

  async function refresh() {
    const res = await fetch("/api/projects", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { projects: ProjectStat[] };
      setProjects(data.projects);
    }
  }

  async function handleSubmit() {
    const name = form.name.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const payload = {
        name,
        short: form.short.trim() || (editingId ? null : undefined),
        color: form.color,
        leadId: form.leadId || (editingId ? null : undefined),
        description: form.description.trim() || (editingId ? null : undefined),
        repoUrl: form.repoUrl.trim() || (editingId ? null : undefined),
        repoPath: form.repoPath.trim() || (editingId ? null : undefined),
      };
      const res = await fetch(editingId ? `/api/projects/${editingId}` : "/api/projects", {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        flashErr(data.error ?? (editingId ? "수정 실패" : "생성 실패"));
        return;
      }
      closeForm();
      await refresh();
    } catch {
      flashErr("네트워크 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(p: ProjectStat) {
    const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      flashErr(data.error ?? "삭제 실패");
      return;
    }
    if (editingId === p.id) closeForm();
    await refresh();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 헤더 툴바 */}
      <div className="ws-filterbar">
        <span style={{ color: "var(--text-sub)", display: "flex" }}>
          <Icon name="folder" size={16} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)" }}>프로젝트</span>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{projects.length}개</span>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" onClick={() => (formOpen ? closeForm() : openCreate())}>
          <Icon name={formOpen ? "close" : "plus"} size={14} />
          {formOpen ? "취소" : "새 프로젝트"}
        </button>
      </div>

      {/* 본문 스크롤 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px 88px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          {/* 생성/수정 폼 */}
          {formOpen && (
            <section style={{ ...cardStyle, marginBottom: 18 }}>
              <h3 style={cardHeadStyle}>{editingId ? "프로젝트 수정" : "새 프로젝트"}</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <div className="ws-search" style={{ flex: "2 1 220px" }}>
                  <span style={{ display: "flex", color: "var(--text-muted)" }}>
                    <Icon name="folder" size={14} />
                  </span>
                  <input
                    placeholder="프로젝트 이름"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSubmit();
                    }}
                    aria-label="프로젝트 이름"
                  />
                </div>
                <div className="ws-search" style={{ flex: "0 1 120px" }}>
                  <span style={{ display: "flex", color: "var(--text-muted)" }}>
                    <Icon name="hash" size={14} />
                  </span>
                  <input
                    placeholder="코드(iOS)"
                    value={form.short}
                    maxLength={8}
                    onChange={(e) => setForm((f) => ({ ...f, short: e.target.value }))}
                    aria-label="짧은 코드"
                  />
                </div>
                <select
                  value={form.leadId}
                  onChange={(e) => setForm((f) => ({ ...f, leadId: e.target.value }))}
                  style={selectStyle}
                  aria-label="리드"
                >
                  <option value="">리드 없음</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* 색상 + 설명 + 버튼 */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }} role="radiogroup" aria-label="색상">
                  {COLOR_KEYS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, color: c }))}
                      aria-label={c}
                      aria-pressed={form.color === c}
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 999,
                        background: colorFor(c),
                        border: form.color === c ? "2px solid var(--text-strong)" : "2px solid transparent",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    />
                  ))}
                </div>
                <input
                  placeholder="설명 (선택)"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  aria-label="설명"
                  style={{
                    flex: "1 1 220px",
                    height: 32,
                    padding: "0 10px",
                    border: "1px solid var(--border-default)",
                    borderRadius: 9,
                    background: "var(--surface-card)",
                    color: "var(--text-body)",
                    fontSize: 12.5,
                    fontFamily: "inherit",
                    outline: "none",
                  }}
                />
                <button
                  className="ws-btn-soft"
                  onClick={() => void handleSubmit()}
                  disabled={busy || !form.name.trim()}
                  style={{
                    flexShrink: 0,
                    background: "var(--color-primary)",
                    color: "#fff",
                    borderColor: "transparent",
                  }}
                >
                  <Icon name="check" size={14} />
                  {editingId ? "저장" : "만들기"}
                </button>
              </div>

              {/* 코드 repo 링크 (선택) */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
                <div className="ws-search" style={{ flex: "2 1 260px" }}>
                  <span style={{ display: "flex", color: "var(--text-muted)" }}>
                    <Icon name="link" size={14} />
                  </span>
                  <input
                    placeholder="코드 repo URL (예: https://github.com/org/repo)"
                    value={form.repoUrl}
                    onChange={(e) => setForm((f) => ({ ...f, repoUrl: e.target.value }))}
                    aria-label="코드 repo URL"
                  />
                </div>
                <div className="ws-search" style={{ flex: "1 1 200px" }}>
                  <span style={{ display: "flex", color: "var(--text-muted)" }}>
                    <Icon name="folder" size={14} />
                  </span>
                  <input
                    placeholder="로컬 경로 (예: ~/dev/sample-app)"
                    value={form.repoPath}
                    onChange={(e) => setForm((f) => ({ ...f, repoPath: e.target.value }))}
                    aria-label="로컬 경로"
                  />
                </div>
              </div>
              {error && (
                <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--color-danger)" }}>{error}</p>
              )}
            </section>
          )}

          {/* 카드 그리드 / 빈 상태 */}
          {projects.length === 0 ? (
            <div
              style={{
                padding: "56px 24px",
                textAlign: "center",
                background: "var(--surface-card)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 14,
                color: "var(--text-sub)",
              }}
            >
              <div style={{ color: "var(--text-muted)", marginBottom: 10 }}>
                <Icon name="folder" size={30} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-strong)", marginBottom: 6 }}>
                아직 프로젝트가 없어요
              </div>
              <div style={{ fontSize: 13 }}>“새 프로젝트”로 첫 작업 영역을 만들어보세요.</div>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
                gap: 14,
              }}
            >
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  p={p}
                  onOpen={() => openBoard(p)}
                  onEdit={() => openEdit(p)}
                  onDelete={() => void handleDelete(p)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============ 카드 ============ */
function ProjectCard({
  p,
  onOpen,
  onEdit,
  onDelete,
}: {
  p: ProjectStat;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const accent = colorFor(p.color);
  const distTotal = p.statusBuckets.reduce((s, b) => s + b.count, 0);
  const [confirming, setConfirming] = useState(false);

  // 카드 본문 클릭(보드 이동)과 액션 버튼 클릭을 분리한다.
  const stop = (e: ReactMouseEvent) => e.stopPropagation();

  return (
    <article
      className="ws-listrow"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={{
        position: "relative",
        background: "var(--surface-card)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 14,
        padding: "16px 16px 14px",
        cursor: p.boardPageId ? "pointer" : "default",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* 액션: 수정 / 삭제(인라인 확인) */}
      <div
        style={{ position: "absolute", top: 10, right: 10, display: "flex", gap: 4, alignItems: "center" }}
        onClick={stop}
      >
        {confirming ? (
          <>
            <span style={{ fontSize: 11.5, color: "var(--color-danger)", fontWeight: 600 }}>삭제?</span>
            <button
              className="ws-btn-soft"
              onClick={(e) => {
                stop(e);
                setConfirming(false);
                onDelete();
              }}
              title="삭제 확인"
              style={{ padding: "0 8px", height: 26, color: "var(--color-danger)" }}
            >
              예
            </button>
            <button
              className="ws-btn-soft"
              onClick={(e) => {
                stop(e);
                setConfirming(false);
              }}
              title="취소"
              style={{ padding: "0 8px", height: 26 }}
            >
              아니오
            </button>
          </>
        ) : (
          <>
            <button
              className="ws-icon-btn"
              onClick={(e) => {
                stop(e);
                onEdit();
              }}
              title="프로젝트 수정"
              aria-label="프로젝트 수정"
              style={{ width: 26, height: 26 }}
            >
              <Icon name="settings" size={14} />
            </button>
            <button
              className="ws-icon-btn"
              onClick={(e) => {
                stop(e);
                setConfirming(true);
              }}
              title="프로젝트 삭제"
              aria-label="프로젝트 삭제"
              style={{ width: 26, height: 26, color: "var(--color-danger)" }}
            >
              <Icon name="close" size={14} />
            </button>
          </>
        )}
      </div>

      {/* 헤더: 색 점 + 이름 + 코드 배지 (디자인 정합) — 우측은 액션 버튼 공간 확보 */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, paddingRight: 52 }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: accent, flexShrink: 0 }} aria-hidden />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 15,
            fontWeight: 700,
            letterSpacing: "-0.01em",
            color: "var(--text-strong)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.name}
        </span>
        {p.short && (
          <span
            style={{
              flexShrink: 0,
              padding: "2px 9px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 700,
              color: `color-mix(in srgb, ${accent} 80%, var(--text-strong))`,
              background: `color-mix(in srgb, ${accent} 13%, var(--surface-card))`,
            }}
          >
            {p.short}
          </span>
        )}
      </div>
      {p.description && (
        <p
          style={{
            margin: 0,
            fontSize: 12.5,
            color: "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {p.description}
        </p>
      )}

      {/* 지표: 열린 태스크(강조) + 마감 칩(지연/임박/여유 항상 표시) — 디자인 정합 */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontFamily: "var(--font-display)", fontSize: 28, fontWeight: 700, color: "var(--text-strong)", lineHeight: 1, letterSpacing: "-0.02em" }}>
            {p.openCount}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-sub)" }}>열린 태스크</span>
        </span>
        {p.overdueCount > 0 ? (
          <span style={chip("var(--color-danger)")}>지연 {p.overdueCount}</span>
        ) : p.dueSoonCount > 0 ? (
          <span style={chip(colorFor("orange"))}>임박 {p.dueSoonCount}</span>
        ) : (
          <span style={chip("var(--text-muted)")}>여유</span>
        )}
      </div>

      {/* 상태 미니바 */}
      {distTotal > 0 ? (
        <div>
          <div style={{ display: "flex", height: 7, borderRadius: 4, overflow: "hidden", background: "var(--surface-sunken)" }}>
            {p.statusBuckets.map((b) => (
              <span
                key={b.name}
                title={`${b.name} ${b.count}`}
                style={{ width: `${(b.count / distTotal) * 100}%`, background: colorFor(b.color) }}
              />
            ))}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>연결된 태스크 보드 없음</div>
      )}

      {/* 코드 repo 링크 */}
      {p.repoUrl && (
        <a
          href={p.repoUrl}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          title={p.repoUrl}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            alignSelf: "flex-start",
            maxWidth: "100%",
            fontSize: 11.5,
            fontFamily: "var(--font-mono)",
            color: "var(--text-sub)",
            background: "var(--surface-sunken)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 7,
            padding: "2px 8px",
            textDecoration: "none",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <Icon name="link" size={12} />
          {repoLabel(p.repoUrl)}
        </a>
      )}

      {/* 푸터: 리드 + 참여자 + 문서수 */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
        {p.lead ? (
          <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <Avatar name={p.lead.name ?? "?"} size={22} />
            <span style={{ fontSize: 12, color: "var(--text-sub)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.lead.name ?? "리드"}
            </span>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>리드 미지정</span>
        )}
        {p.participants.length > 0 && <AvatarStack names={p.participants} size={22} max={3} />}
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>
          <Icon name="doc" size={13} />
          {p.docCount}
        </span>
        <span style={{ flex: 1 }} />
        {p.boardPageId && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 11.5, fontWeight: 600, color: "var(--color-primary)", whiteSpace: "nowrap" }}>
            보드 열기 <Icon name="chevronRight" size={13} />
          </span>
        )}
      </div>
    </article>
  );
}

function chip(color: string): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 8px",
    borderRadius: 999,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    color: `color-mix(in srgb, ${color} 78%, var(--text-strong))`,
  };
}

/* ── 공유 스타일 ── */
const cardStyle: CSSProperties = {
  background: "var(--surface-card)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 12,
  padding: 18,
};

const cardHeadStyle: CSSProperties = {
  margin: "0 0 12px",
  fontSize: 13.5,
  fontWeight: 700,
  color: "var(--text-strong)",
};

const selectStyle: CSSProperties = {
  height: 32,
  padding: "0 8px",
  border: "1px solid var(--border-default)",
  borderRadius: 9,
  background: "var(--surface-card)",
  color: "var(--text-body)",
  fontSize: 12.5,
  fontFamily: "inherit",
  fontWeight: 600,
  outline: "none",
};

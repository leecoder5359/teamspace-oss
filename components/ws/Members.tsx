"use client";

import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Avatar } from "./ui";
import { Icon } from "./icons";

/* =====================================================================
   멤버 관리 화면 — 현재 워크스페이스 멤버 조회·추가·역할 변경·제거.
   Saebit 디자인 토큰(surface-card, border-subtle, text-* 등)을 그대로 사용.
   ===================================================================== */

type Role = "admin" | "editor" | "viewer";

const ROLE_LABELS: Record<Role, string> = {
  admin: "관리자",
  editor: "편집자",
  viewer: "뷰어",
};

const VALID_ROLES: Role[] = ["admin", "editor", "viewer"];

export type MemberUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

export type MemberItem = {
  id: string;
  role: Role;
  teamId: string | null;
  status: string; // active | invited
  user: MemberUser;
};

export type TeamItem = {
  id: string;
  name: string;
  color: string;
  memberCount: number;
};

const TEAM_COLORS = ["blue", "orange", "purple", "green", "red", "gray"];
const teamColor = (c: string) => (c === "blue" ? "#2F62FF" : c === "orange" ? "#F5A623" : c === "purple" ? "#7165E3" : c === "green" ? "#12B886" : c === "red" ? "#F0494E" : "#9AA0A6");

/* admin 멤버가 이 member 1명뿐인지 확인 */
function isLastAdmin(members: MemberItem[], memberId: string): boolean {
  const m = members.find((x) => x.id === memberId);
  if (m?.role !== "admin") return false;
  return members.filter((x) => x.role === "admin").length <= 1;
}

/* =====================================================================
   Component
   ===================================================================== */
export default function Members({
  initialMembers,
  initialTeams,
  currentUserId,
}: {
  initialMembers: MemberItem[];
  initialTeams: TeamItem[];
  currentUserId: string;
}) {
  const [members, setMembers] = useState<MemberItem[]>(initialMembers);
  const [teams, setTeams] = useState<TeamItem[]>(initialTeams);
  const [email, setEmail] = useState("");
  const [addRole, setAddRole] = useState<Role>("editor");
  const [adding, setAdding] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamColorSel, setTeamColorSel] = useState("blue");
  const [feedback, setFeedback] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* 팀 생성 */
  async function createTeam() {
    const name = teamName.trim();
    if (!name) return;
    const res = await fetch("/api/teams", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, color: teamColorSel }) });
    const data = (await res.json()) as { team?: TeamItem; error?: string };
    if (!res.ok) flash("err", data.error ?? "팀 생성 실패");
    else { setTeams((p) => [...p, data.team!]); setTeamName(""); flash("ok", `팀 '${name}'을 만들었어요.`); }
  }
  /* 팀 삭제 */
  async function deleteTeam(id: string) {
    const res = await fetch(`/api/teams/${id}`, { method: "DELETE" });
    if (!res.ok) { const d = (await res.json().catch(() => ({}))) as { error?: string }; flash("err", d.error ?? "삭제 실패"); return; }
    setTeams((p) => p.filter((t) => t.id !== id));
    setMembers((p) => p.map((m) => (m.teamId === id ? { ...m, teamId: null } : m)));
  }
  /* 멤버 팀 배정 */
  async function assignTeam(memberId: string, teamId: string | null) {
    const res = await fetch(`/api/members/${memberId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ teamId }) });
    const data = (await res.json()) as { member?: MemberItem; error?: string };
    if (!res.ok) { flash("err", data.error ?? "팀 배정 실패"); return; }
    setMembers((prev) => prev.map((m) => (m.id === memberId ? { ...m, teamId } : m)));
  }

  function flash(type: "ok" | "err", msg: string) {
    if (timerRef.current) clearTimeout(timerRef.current);
    setFeedback({ type, msg });
    timerRef.current = setTimeout(() => setFeedback(null), 3500);
  }

  /* 멤버 추가 */
  async function handleAdd() {
    const trimmed = email.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    try {
      const res = await fetch("/api/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: trimmed, role: addRole }),
      });
      const data = (await res.json()) as { member?: MemberItem; error?: string };
      if (!res.ok) {
        flash("err", data.error ?? "추가 실패");
      } else {
        setMembers((prev) => [...prev, data.member!]);
        setEmail("");
        flash("ok", `${trimmed} 님이 추가되었습니다.`);
      }
    } catch {
      flash("err", "네트워크 오류가 발생했습니다.");
    } finally {
      setAdding(false);
    }
  }

  /* 역할 변경 */
  async function handleRoleChange(memberId: string, newRole: Role) {
    const res = await fetch(`/api/members/${memberId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    const data = (await res.json()) as { member?: MemberItem; error?: string };
    if (!res.ok) {
      flash("err", data.error ?? "역할 변경 실패");
    } else {
      setMembers((prev) => prev.map((m) => (m.id === memberId ? data.member! : m)));
    }
  }

  /* 멤버 제거 */
  async function handleRemove(memberId: string) {
    const res = await fetch(`/api/members/${memberId}`, { method: "DELETE" });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) {
      flash("err", data.error ?? "제거 실패");
    } else {
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
    }
  }

  /* ── render ── */
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 헤더 툴바 */}
      <div className="ws-filterbar">
        <span style={{ color: "var(--text-sub)", display: "flex" }}>
          <Icon name="users" size={16} />
        </span>
        <span
          style={{
            fontSize: 14,
            fontWeight: 700,
            color: "var(--text-strong)",
          }}
        >
          멤버
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          {members.length}명
        </span>
      </div>

      {/* 본문 스크롤 영역 */}
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px 80px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* ── 멤버 추가 카드 ── */}
          <section style={cardStyle}>
            <h3 style={cardHeadStyle}>멤버 추가</h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {/* 이메일 입력 */}
              <div className="ws-search" style={{ flex: "1 1 220px" }}>
                <span style={{ display: "flex", color: "var(--text-muted)" }}>
                  <Icon name="user" size={14} />
                </span>
                <input
                  type="email"
                  placeholder="이메일 주소"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAdd();
                  }}
                  aria-label="추가할 멤버 이메일"
                />
              </div>
              {/* 역할 선택 */}
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value as Role)}
                style={selectStyle}
                aria-label="역할 선택"
              >
                {VALID_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              {/* 추가 버튼 */}
              <button
                className="ws-btn-soft"
                onClick={() => void handleAdd()}
                disabled={adding || !email.trim()}
                style={{ flexShrink: 0 }}
              >
                <Icon name="plus" size={14} />
                추가
              </button>
            </div>
            {/* 인라인 피드백 */}
            {feedback && (
              <p
                style={{
                  margin: "10px 0 0",
                  fontSize: 12.5,
                  color:
                    feedback.type === "ok"
                      ? "var(--color-success)"
                      : "var(--color-danger)",
                }}
              >
                {feedback.msg}
              </p>
            )}
          </section>

          {/* ── 팀 관리 ── */}
          <section style={cardStyle}>
            <h3 style={cardHeadStyle}>팀 <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{teams.length}</span></h3>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: teams.length ? 14 : 0 }}>
              <div className="ws-search" style={{ flex: "1 1 200px" }}>
                <span style={{ display: "flex", color: "var(--text-muted)" }}><Icon name="users" size={14} /></span>
                <input placeholder="새 팀 이름" value={teamName} onChange={(e) => setTeamName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void createTeam(); }} aria-label="새 팀 이름" />
              </div>
              <select value={teamColorSel} onChange={(e) => setTeamColorSel(e.target.value)} style={selectStyle} aria-label="팀 색상">
                {TEAM_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <button className="ws-btn-soft" onClick={() => void createTeam()} disabled={!teamName.trim()} style={{ flexShrink: 0 }}><Icon name="plus" size={14} /> 팀 만들기</button>
            </div>
            {teams.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {teams.map((t) => {
                  const count = members.filter((m) => m.teamId === t.id).length;
                  return (
                    <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "9px 12px" }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: teamColor(t.color), flexShrink: 0 }} />
                      <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-strong)" }}>{t.name}</span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{count}명</span>
                      <span style={{ flex: 1 }} />
                      <button className="ws-btn-soft" onClick={() => void deleteTeam(t.id)} title="팀 삭제" aria-label="팀 삭제" style={{ padding: "0 9px", color: "var(--color-danger)" }}><Icon name="close" size={13} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── 멤버 목록 ── */}
          <section style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
            <div style={listHeadStyle}>
              워크스페이스 멤버&ensp;·&ensp;{members.length}명
            </div>

            {members.length === 0 ? (
              <div
                className="ws-empty-hint"
                style={{ padding: "28px 20px", textAlign: "center" }}
              >
                아직 멤버가 없어요.
              </div>
            ) : (
              members.map((member, idx) => {
                const isMe = member.user.id === currentUserId;
                const locked = isLastAdmin(members, member.id);
                const displayName = member.user.name ?? member.user.email;

                return (
                  <div
                    key={member.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "12px 16px",
                      ...(idx > 0
                        ? { borderTop: "1px solid var(--border-subtle)" }
                        : {}),
                    }}
                  >
                    {/* 아바타 */}
                    <Avatar name={displayName} size={36} />

                    {/* 이름 + 이메일 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13.5,
                            fontWeight: 600,
                            color: "var(--text-strong)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {displayName}
                        </span>
                        {isMe && (
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 600,
                              color: "var(--color-primary)",
                              background: "var(--color-primary-weak)",
                              padding: "1px 6px",
                              borderRadius: 999,
                              flexShrink: 0,
                              lineHeight: 1.7,
                            }}
                          >
                            나
                          </span>
                        )}
                        {member.status === "invited" && (
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              color: "#E0900F",
                              background: "color-mix(in srgb, #F5A623 16%, var(--surface-card))",
                              padding: "1px 6px",
                              borderRadius: 999,
                              flexShrink: 0,
                              lineHeight: 1.7,
                            }}
                          >
                            초대됨
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          marginTop: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {member.user.email}
                      </div>
                    </div>

                    {/* 팀 드롭다운 */}
                    {teams.length > 0 && (
                      <select
                        value={member.teamId ?? ""}
                        onChange={(e) => void assignTeam(member.id, e.target.value || null)}
                        aria-label="팀"
                        title="팀 배정"
                        style={selectStyle}
                      >
                        <option value="">미배정</option>
                        {teams.map((t) => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                    )}

                    {/* 역할 드롭다운 */}
                    <select
                      value={member.role}
                      onChange={(e) =>
                        void handleRoleChange(member.id, e.target.value as Role)
                      }
                      disabled={locked}
                      title={
                        locked
                          ? "마지막 관리자의 역할은 변경할 수 없습니다."
                          : undefined
                      }
                      aria-label="역할"
                      style={{
                        ...selectStyle,
                        opacity: locked ? 0.5 : 1,
                        cursor: locked ? "not-allowed" : "pointer",
                      }}
                    >
                      {VALID_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>

                    {/* 제거 버튼 */}
                    <button
                      className="ws-btn-soft"
                      onClick={() => void handleRemove(member.id)}
                      disabled={locked}
                      title={
                        locked
                          ? "마지막 관리자는 제거할 수 없습니다."
                          : "멤버 제거"
                      }
                      aria-label="멤버 제거"
                      style={{
                        flexShrink: 0,
                        padding: "0 9px",
                        color: locked
                          ? "var(--text-disabled)"
                          : "var(--color-danger)",
                        cursor: locked ? "not-allowed" : "pointer",
                      }}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                );
              })
            )}
          </section>
        </div>
      </div>
    </div>
  );
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

const listHeadStyle: CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--border-subtle)",
  fontSize: 11.5,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
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

"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import type { IconName } from "./icons";

/* =====================================================================
   설정 — 워크스페이스 정보/이름 변경(admin), 내 프로필, 빠른 이동.
   ===================================================================== */

type Info = {
  workspace: { id: string; name: string; createdAt: string } | null;
  role: "admin" | "editor" | "viewer" | null;
  me: { name: string | null; email: string | null } | null;
  memberCount: number;
};

const ROLE_LABEL: Record<string, string> = { admin: "관리자", editor: "편집자", viewer: "뷰어" };

type WsItem = { id: string; name: string; role: string; memberCount: number; current: boolean };

export default function Settings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WsItem[]>([]);
  const [newWs, setNewWs] = useState("");

  async function load() {
    const res = await fetch("/api/workspace", { cache: "no-store" });
    const data = (await res.json()) as Info;
    setInfo(data);
    setName(data.workspace?.name ?? "");
    const wsRes = await fetch("/api/workspaces", { cache: "no-store" });
    if (wsRes.ok) setWorkspaces(((await wsRes.json()) as { workspaces: WsItem[] }).workspaces);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function switchTo(id: string) {
    const res = await fetch("/api/workspaces/switch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId: id }) });
    if (res.ok) window.location.reload();
  }
  async function createWs() {
    const n = newWs.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
      if (res.ok) window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/workspace", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const d = await res.json();
      setMsg(res.ok ? "저장했습니다." : d.error ?? "저장 실패");
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  if (info === null) return <div className="ws-db" style={{ padding: 40 }} />;
  const isAdmin = info.role === "admin";

  return (
    <div className="ws-db" style={{ maxWidth: 720 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="settings" /> 설정
      </h1>

      {/* 워크스페이스 */}
      <Section title="워크스페이스">
        <label style={labelStyle}>이름</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isAdmin}
            style={{ ...inputStyle, flex: 1, opacity: isAdmin ? 1 : 0.6 }}
          />
          {isAdmin && (
            <button onClick={save} disabled={busy || !name.trim() || name === info.workspace?.name} style={primaryBtn}>
              저장
            </button>
          )}
        </div>
        {!isAdmin && <p style={hint}>이름 변경은 관리자만 가능합니다.</p>}
        {msg && <p style={{ ...hint, color: "var(--text-body)" }}>{msg}</p>}
        <p style={hint}>멤버 {info.memberCount}명 · 생성 {info.workspace ? new Date(info.workspace.createdAt).toLocaleDateString("ko-KR") : "-"}</p>
      </Section>

      {/* 워크스페이스 전환 */}
      {workspaces.length > 0 && (
        <Section title="워크스페이스 전환">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {workspaces.map((w) => (
              <div
                key={w.id}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9,
                  border: `1px solid ${w.current ? "var(--color-primary)" : "var(--border-subtle)"}`,
                  background: w.current ? "var(--surface-muted, rgba(0,0,0,0.02))" : "var(--surface-card)",
                }}
              >
                <span style={{ display: "flex", color: "var(--color-primary)" }}>
                  <Icon name={w.current ? "check" : "folder"} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{ROLE_LABEL[w.role] ?? w.role} · {w.memberCount}명</div>
                </div>
                {w.current ? (
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-primary)" }}>현재</span>
                ) : (
                  <button onClick={() => switchTo(w.id)} style={ghostBtn}>전환</button>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              value={newWs}
              onChange={(e) => setNewWs(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void createWs(); }}
              placeholder="새 워크스페이스 이름"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button onClick={createWs} disabled={busy || !newWs.trim()} style={primaryBtn}>만들기</button>
          </div>
        </Section>
      )}

      {/* 내 프로필 */}
      <Section title="내 프로필">
        <div style={{ fontSize: 13.5, color: "var(--text-strong)", fontWeight: 600 }}>{info.me?.name ?? "이름 없음"}</div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 2 }}>
          {info.me?.email ?? "-"} · {info.role ? ROLE_LABEL[info.role] : "-"}
        </div>
      </Section>

      {/* 에이전트 토큰 (admin) */}
      {isAdmin && <AgentTokens />}

      {/* 휴지통 */}
      <TrashSection />

      {/* 빠른 이동 */}
      <Section title="연결 / 관리">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <NavCard href="/members" icon="users" label="멤버 관리" />
          <NavCard href="/slack" icon="slack" label="슬랙 연동" />
          <NavCard href="/approvals" icon="inbox" label="승인" />
          <NavCard href="/reminders" icon="bell" label="리마인더" />
          <NavCard href="/clip" icon="link" label="웹 클리퍼" />
        </div>
      </Section>
    </div>
  );
}

/* 휴지통 (W2): 소프트 삭제된 페이지 목록·복원·영구 삭제. */
type TrashItem = {
  id: string;
  title: string;
  kind: string;
  deletedAt: string;
  project: { id: string; name: string } | null;
};

function TrashSection() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/trash", { cache: "no-store" });
    if (res.ok) setItems(((await res.json()) as { pages: TrashItem[] }).pages);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function restore(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/trash/${id}`, { method: "POST" });
      if (res.ok) {
        await load();
        window.dispatchEvent(new CustomEvent("pages:changed"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function purge(id: string) {
    if (busy) return;
    if (!window.confirm("영구 삭제할까요? 문서 파일까지 지워지며 되돌릴 수 없습니다.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/trash/${id}`, { method: "DELETE" });
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  if (items === null || items.length === 0) return null; // 비어 있으면 섹션 숨김

  return (
    <Section title="휴지통">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((t) => (
          <div
            key={t.id}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)" }}
          >
            <span style={{ display: "flex", color: "var(--text-muted)" }}>
              <Icon name={t.kind === "database" ? "table" : "doc"} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                {t.project?.name ?? "미분류"} · 삭제 {new Date(t.deletedAt).toLocaleString("ko-KR")}
              </div>
            </div>
            <button onClick={() => void restore(t.id)} disabled={busy} style={ghostBtn}>복원</button>
            <button onClick={() => void purge(t.id)} disabled={busy} style={{ ...ghostBtn, color: "#C0392B" }}>영구 삭제</button>
          </div>
        ))}
      </div>
    </Section>
  );
}

/* 에이전트 토큰 관리 (W1): 발급(원문 1회 노출)·목록·회수. 에이전트는 발급 시 멤버로 함께 생성된다. */
type TokenItem = {
  id: string;
  name: string;
  role: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

function AgentTokens() {
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [name, setName] = useState("");
  const [role, setRole] = useState("editor");
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/agent-tokens", { cache: "no-store" });
    if (res.ok) setTokens(((await res.json()) as { tokens: TokenItem[] }).tokens);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function issue() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setIssued(null);
    try {
      const res = await fetch("/api/agent-tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: n, role }),
      });
      const d = (await res.json()) as { token?: string; error?: string };
      if (res.ok && d.token) {
        setIssued(d.token);
        setName("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("이 토큰을 회수할까요? 해당 에이전트는 즉시 접근을 잃습니다.")) return;
    const res = await fetch(`/api/agent-tokens/${id}`, { method: "DELETE" });
    if (res.ok) await load();
  }

  return (
    <Section title="에이전트 토큰">
      <p style={{ ...hint, marginTop: 0, marginBottom: 10 }}>
        Claude 등 에이전트가 API 로 워크스페이스를 조작할 때 쓰는 전용 토큰입니다. 발급하면 에이전트가 멤버 목록에
        팀원으로 표시되고, 작성·변경 기록도 에이전트 이름으로 남습니다.
      </p>
      {tokens.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
          {tokens.map((t) => (
            <div
              key={t.id}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9,
                border: "1px solid var(--border-subtle)", background: "var(--surface-card)",
                opacity: t.revokedAt ? 0.55 : 1,
              }}
            >
              <span style={{ display: "flex", color: "var(--color-primary)" }}>
                <Icon name="user" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)" }}>
                  {t.name}
                  {t.revokedAt && <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--text-muted)", fontWeight: 500 }}>회수됨</span>}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  {ROLE_LABEL[t.role] ?? t.role} · 발급 {new Date(t.createdAt).toLocaleDateString("ko-KR")}
                  {t.lastUsedAt ? ` · 마지막 사용 ${new Date(t.lastUsedAt).toLocaleString("ko-KR")}` : " · 미사용"}
                </div>
              </div>
              {!t.revokedAt && (
                <button onClick={() => void revoke(t.id)} style={ghostBtn}>회수</button>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void issue(); }}
          placeholder="에이전트 이름 (예: office-claude)"
          style={{ ...inputStyle, flex: 1 }}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)} style={inputStyle}>
          <option value="editor">편집자</option>
          <option value="viewer">뷰어</option>
          <option value="admin">관리자</option>
        </select>
        <button onClick={issue} disabled={busy || !name.trim()} style={primaryBtn}>발급</button>
      </div>
      {issued && (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 9, border: "1px solid var(--color-primary)", background: "var(--surface-muted, rgba(0,0,0,0.02))" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-strong)", marginBottom: 4 }}>
            토큰이 발급되었습니다 — 지금 복사하세요. 다시 볼 수 없습니다.
          </div>
          <code style={{ fontSize: 12, wordBreak: "break-all", color: "var(--text-body)" }}>{issued}</code>
          <div style={{ marginTop: 8 }}>
            <button onClick={() => void navigator.clipboard.writeText(issued)} style={ghostBtn}>복사</button>
          </div>
        </div>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16, marginTop: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function NavCard({ href, icon, label }: { href: string; icon: IconName; label: string }) {
  return (
    <Link
      href={href}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 14px", borderRadius: 10, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontWeight: 600, textDecoration: "none" }}
    >
      <span style={{ display: "flex", color: "var(--color-primary)" }}>
        <Icon name={icon} />
      </span>
      {label}
    </Link>
  );
}

const labelStyle: CSSProperties = { display: "block", fontSize: 12.5, color: "var(--text-muted)", marginBottom: 4 };
const inputStyle: CSSProperties = {
  padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)",
  background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit",
};
const primaryBtn: CSSProperties = {
  padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer",
  border: "1px solid transparent", background: "var(--color-primary)", color: "#fff", whiteSpace: "nowrap",
};
const ghostBtn: CSSProperties = {
  padding: "6px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", whiteSpace: "nowrap",
};
const hint: CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginTop: 8 };

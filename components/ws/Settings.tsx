"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { Icon } from "./icons";
import DataTransfer from "./DataTransfer";
import AiRoutes from "./AiRoutes";
import OpsStatus from "./OpsStatus";
import LessonInspect from "./LessonInspect";
import SkillRegistry from "./SkillRegistry";
import LiveSessions from "./LiveSessions";
import { StatusPill } from "./ui";
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
    if (res.ok) {
      window.location.reload();
      return;
    }
    // 종전엔 else 분기가 없어 버튼을 눌러도 아무 일이 안 일어났다(D4·D13)
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    setMsg(d.error ?? "워크스페이스를 전환하지 못했습니다.");
  }
  async function createWs() {
    const n = newWs.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
      if (res.ok) {
        window.location.reload();
        return;
      }
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(d.error ?? "워크스페이스를 만들지 못했습니다.");
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

      {/* 운영 상태 (admin) — health·백업·디스크·오늘 AI 비용 + 경고 */}
      {isAdmin && (
        <Section title="운영 상태">
          <OpsStatus />
        </Section>
      )}

      {/* AI 실행 경로 (admin) — 사용처·사용량·외부 중계 상태 */}
      {isAdmin && (
        <Section title="AI 실행 경로">
          <AiRoutes />
        </Section>
      )}

      {/* 레슨 주입 점검 (편집자 이상) — 세션 주입 시뮬레이터·연결 점검·주입 기록·정리 후보 */}
      {(isAdmin || info.role === "editor") && (
        <Section title="레슨 주입 점검">
          <LessonInspect />
        </Section>
      )}

      {/* 스킬 레지스트리 (admin — 로컬 경로가 드러남) — SKILL.md 사본·낡은 사본·기준본 비교 */}
      {isAdmin && (
        <Section title="스킬 레지스트리">
          <SkillRegistry />
        </Section>
      )}

      {/* 라이브 세션·잠금 (편집자 이상) — 돌고 있는 세션의 레포·브랜치·태스크 + 공유 브랜치·배포 잠금(관리자 강제 해제) */}
      {(isAdmin || info.role === "editor") && (
        <Section title="라이브 세션·잠금">
          <LiveSessions isAdmin={isAdmin} />
        </Section>
      )}

      {/* 에이전트 토큰 (admin) */}
      {isAdmin && <AgentTokens />}

      {/* env 금고 — 목록은 멤버 누구나(값 없음), 값 보기·편집·삭제·감사 로그는 관리자 */}
      <EnvVaultSection isAdmin={isAdmin} />

      {/* 휴지통 */}
      <TrashSection />

      {/* 빠른 이동 */}
      {/* 데이터 반출입(격차 E2 후속) — API·CLI 로만 있던 것을 화면으로 */}
      <Section title="데이터 반출입">
        <DataTransfer />
      </Section>

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
    // 멤버 화면의 에이전트 목록이 /settings#agent-tokens 로 이 절에 바로 온다.
    <Section title="에이전트 토큰" id="agent-tokens">
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
          placeholder="에이전트 이름 (예: mac-mini-claude)"
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

/* env 금고 (P1·P2): 프로젝트·환경별 키 목록, 관리자만 값 보기(감사 기록)·추가/편집·삭제·감사 로그.
   값은 화면에 꺼내 볼 때만 서버에서 받아오고, 숨기면 상태에서 지운다.
   P2: 반영 대상(로컬 .env·AWS SSM·Vercel·GitHub Actions) 목록·추가·삭제, 키마다 대상별 동기 상태. 실제 반영은 CLI(사람 승인).
   P3: 대상별 마지막 드리프트 점검(CLI 가 원격과 비교한 키별 상태)·syncGroup 값 불일치 경고. 값은 표시하지 않는다. */
type EnvVarItem = {
  id: string;
  env: string;
  key: string;
  version: number;
  valueLength: number;
  note: string | null;
  syncGroup: string | null;
  updatedByName: string | null;
  updatedAt: string;
  sync?: Record<string, "match" | "differs" | "never">;
  drift?: Record<string, string>;
};
type EnvTargetItem = {
  id: string;
  env: string;
  kind: "dotenv" | "ssm" | "vercel" | "gha";
  summary: string;
  accountSummary: string;
  lastPushedAt: string | null;
  lastDriftAt?: string | null;
  lastDrift?: Record<string, string>;
  driftIssues?: number;
};
type SyncGroupItem = { name: string; consistent: boolean; members: { projectId: string; projectName: string; env: string; key: string; varId: string }[] };
type TargetForm = {
  env: string; kind: EnvTargetItem["kind"]; path: string; prefix: string; region: string; profile: string;
  project: string; target: string; scope: string; globalDir: string; repo: string; ghEnv: string; account: string;
};
const TARGET_KIND_LABEL: Record<string, string> = { dotenv: "로컬 .env 파일", ssm: "AWS SSM", vercel: "Vercel", gha: "GitHub Actions" };
const TARGET_ACCOUNT_HINT: Record<string, string> = {
  ssm: "기대 AWS 계정 id (숫자 12자리)", vercel: "기대 Vercel 사용자 (vercel whoami)", gha: "기대 GitHub 로그인",
};
const SYNC_PILL: Record<string, { label: string; color: string }> = {
  match: { label: "일치", color: "green" }, differs: { label: "다름", color: "orange" }, never: { label: "반영 안 됨", color: "gray" },
};
// 드리프트 점검(원격 실제 상태) — 금고 ↔ 원격
const DRIFT_PILL: Record<string, { label: string; color: string }> = {
  match: { label: "원격 일치", color: "green" }, present: { label: "원격에 있음", color: "green" },
  differs: { label: "원격 다름", color: "orange" }, missing_remote: { label: "원격 없음", color: "orange" }, remote_only: { label: "원격에만", color: "orange" },
};
type EnvLogItem = { id: string; at: string; actorType: string; actorName: string; action: string; env: string | null; keys: string[]; viaFunnel: boolean };

const ENV_ACTION_LABEL: Record<string, string> = {
  list: "목록", reveal: "값 보기", set: "설정", delete: "삭제", import_request: "가져오기 요청", import_apply: "가져오기 적용", pull: "내려받기",
  push_request: "반영 요청", push: "반영 값 받음", push_result: "반영 결과", target_add: "대상 추가", target_update: "대상 수정", target_delete: "대상 삭제",
  drift: "드리프트 점검", drift_read: "점검용 값 받음", meta: "메모·syncGroup 변경",
};

function EnvVaultSection({ isAdmin }: { isAdmin: boolean }) {
  const [projects, setProjects] = useState<{ id: string; name: string; archivedAt: string | null }[]>([]);
  const [projectId, setProjectId] = useState("");
  const [env, setEnv] = useState("");
  const [envs, setEnvs] = useState<string[]>([]);
  const [vars, setVars] = useState<EnvVarItem[]>([]);
  const [disabled, setDisabled] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [form, setForm] = useState<{ key: string; value: string; env: string; syncGroup: string; note: string; editing: boolean } | null>(null);
  const [logs, setLogs] = useState<EnvLogItem[]>([]);
  const [targets, setTargets] = useState<EnvTargetItem[]>([]);
  const [groups, setGroups] = useState<SyncGroupItem[]>([]);
  const [tform, setTform] = useState<TargetForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const envInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      // 보관 포함으로 받아 이름 라벨을 잃지 않되, 선택지·기본 선택은 활성 프로젝트만
      const res = await fetch("/api/projects?archived=all", { cache: "no-store" });
      if (!res.ok) return;
      const ps = ((await res.json()) as { projects: { id: string; name: string; archivedAt?: string | null }[] }).projects
        .map((p) => ({ id: p.id, name: p.name, archivedAt: p.archivedAt ?? null }));
      setProjects(ps);
      const first = ps.find((p) => !p.archivedAt);
      if (first) setProjectId(first.id);
    })();
  }, []);

  async function load(pid = projectId, e = env) {
    if (!pid) return;
    const qs = new URLSearchParams({ projectId: pid, ...(e ? { env: e } : {}) });
    const res = await fetch(`/api/env?${qs}`, { cache: "no-store" });
    const d = (await res.json().catch(() => ({}))) as { vars?: EnvVarItem[]; envs?: string[]; targets?: EnvTargetItem[]; error?: string };
    if (res.status === 503) {
      setDisabled(d.error ?? "env 금고가 꺼져 있습니다.");
      return;
    }
    setDisabled(null);
    if (!res.ok) {
      setMsg(d.error ?? "목록을 불러오지 못했습니다.");
      return;
    }
    setVars(d.vars ?? []);
    setEnvs(d.envs ?? []);
    setTargets(d.targets ?? []);
    setRevealed({});
    const gr = await fetch("/api/env/sync-groups", { cache: "no-store" });
    if (gr.ok) setGroups(((await gr.json()) as { syncGroups: SyncGroupItem[] }).syncGroups ?? []);
    await loadLogs(pid);
  }
  async function loadLogs(pid = projectId) {
    if (!isAdmin || !pid) return;
    const lr = await fetch(`/api/env/log?${new URLSearchParams({ projectId: pid, limit: "50" })}`, { cache: "no-store" });
    if (lr.ok) setLogs(((await lr.json()) as { logs: EnvLogItem[] }).logs);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(projectId, env);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, env]);

  async function toggleReveal(id: string) {
    if (revealed[id] !== undefined) {
      setRevealed((r) => {
        const next = { ...r };
        delete next[id];
        return next;
      });
      return;
    }
    const res = await fetch("/api/env/reveal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [id] }) });
    const d = (await res.json().catch(() => ({}))) as { vars?: { id: string; value: string }[]; error?: string };
    if (!res.ok || !d.vars?.[0]) {
      setMsg(d.error ?? "값을 열지 못했습니다.");
      return;
    }
    setRevealed((r) => ({ ...r, [id]: d.vars![0].value }));
    await loadLogs(); // 목록을 다시 부르면 열어 둔 값이 지워진다 — 로그만 갱신
  }

  // 제출 버튼은 실제 disabled 대신 aria-disabled + 여기 가드(팀 레슨): 포커스가 body 로 떨어지지 않고,
  // 눌렀을 때 무엇이 빠졌는지 알려 주고 그 칸으로 포커스를 옮긴다.
  async function save() {
    if (!form || busy) return;
    // 편집에서 값을 비워 두면 값은 그대로 두고 syncGroup·메모만 바꾼다
    const metaOnly = form.editing && form.value === "";
    const missing = !form.env.trim() ? envInput : !form.key.trim() ? keyInput : form.value === "" && !metaOnly ? valueInput : null;
    if (missing) {
      setMsg(missing === valueInput ? "값을 입력해 주세요." : missing === keyInput ? "키 이름을 입력해 주세요." : "환경을 입력해 주세요.");
      missing.current?.focus();
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const editingId = metaOnly ? vars.find((v) => v.env === form.env && v.key === form.key)?.id : undefined;
      if (metaOnly && !editingId) {
        setMsg("키를 찾지 못했습니다. 목록을 새로 고친 뒤 다시 시도하세요.");
        return;
      }
      const res = metaOnly
        ? await fetch(`/api/env/vars/${editingId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ syncGroup: form.syncGroup, note: form.note }),
          })
        : await fetch("/api/env/vars", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId, env: form.env.trim(), key: form.key.trim(), value: form.value, syncGroup: form.syncGroup, note: form.note }),
          });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMsg(d.error ?? "저장하지 못했습니다.");
        return;
      }
      setMsg(`${form.key.trim()} 저장했습니다.`);
      setForm(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(v: EnvVarItem) {
    if (busy) return;
    if (!window.confirm(`${v.env} 의 ${v.key} 를 삭제할까요? 이전 값 이력도 함께 지워지며 되돌릴 수 없습니다.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/env/vars/${v.id}`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(res.ok ? `${v.key} 삭제했습니다.` : d.error ?? "삭제하지 못했습니다.");
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveTarget() {
    if (!tform || busy) return;
    const f = tform;
    const need: [string, string][] =
      f.kind === "dotenv" ? [[f.path, "파일 경로"]]
      : f.kind === "ssm" ? [[f.prefix, "SSM 경로"], [f.account, "AWS 계정 id"]]
      : f.kind === "vercel" ? [[f.project, "Vercel 프로젝트"], [f.account, "Vercel 사용자"]]
      : [[f.repo, "저장소(owner/repo)"], [f.account, "GitHub 로그인"]];
    const missing = [[f.env, "환경"] as [string, string], ...need].find(([v]) => !v.trim());
    if (missing) {
      setMsg(`${missing[1]}을(를) 입력해 주세요.`);
      return;
    }
    const clean = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const config =
      f.kind === "dotenv" ? clean({ path: f.path })
      : f.kind === "ssm" ? clean({ prefix: f.prefix, region: f.region, profile: f.profile })
      : f.kind === "vercel" ? clean({ project: f.project, target: f.target, scope: f.scope, globalDir: f.globalDir })
      : clean({ repo: f.repo, environment: f.ghEnv });
    const account = f.kind === "dotenv" ? {} : { [f.kind === "ssm" ? "accountId" : f.kind === "vercel" ? "user" : "login"]: f.account.trim() };
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/env/targets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, env: f.env.trim(), kind: f.kind, config, account }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setMsg(d.error ?? "대상을 추가하지 못했습니다.");
        return;
      }
      setMsg("반영 대상을 추가했습니다.");
      setTform(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeTarget(t: EnvTargetItem) {
    if (busy) return;
    if (!window.confirm(`${t.env} 의 반영 대상(${TARGET_KIND_LABEL[t.kind]} ${t.summary})을 지울까요? 대상에 이미 반영된 값은 그대로 남습니다.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/env/targets/${t.id}`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg(res.ok ? "반영 대상을 지웠습니다." : d.error ?? "대상을 지우지 못했습니다.");
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  const targetById = new Map(targets.map((t) => [t.id, t]));

  if (disabled) {
    return (
      <Section title="env 금고">
        <p style={{ ...hint, marginTop: 0 }}>
          {disabled} 서버 환경변수에 <code>ENV_VAULT_KEY</code>(생성: <code>openssl rand -base64 32</code>)를 설정하고 재시작하면 켜집니다.
          키를 잃으면 저장된 값을 복구할 수 없으니 따로 백업해 두세요.
        </p>
      </Section>
    );
  }

  return (
    <Section title="env 금고">
      <p style={{ ...hint, marginTop: 0, marginBottom: 10 }}>
        프로젝트·환경별 env 값을 암호화해 보관합니다. 목록에는 값이 나오지 않습니다.
        {isAdmin ? " 값 보기·편집·삭제는 감사 로그에 남습니다." : " 값 보기·편집은 관리자만 할 수 있습니다."}
        {" "}CLI: <code>pnpm ws env pull &lt;프로젝트&gt; &lt;env&gt; --out .env.local</code>
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <select value={projectId} onChange={(e) => { setEnv(""); setProjectId(e.target.value); }} style={{ ...inputStyle, flex: 1, minWidth: 0 }}>
          {projects.filter((p) => !p.archivedAt || p.id === projectId).map((p) => <option key={p.id} value={p.id}>{p.archivedAt ? `${p.name} (보관)` : p.name}</option>)}
        </select>
        <select value={env} onChange={(e) => setEnv(e.target.value)} style={inputStyle}>
          <option value="">모든 환경</option>
          {envs.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
        {isAdmin && (
          <button
            onClick={() => setForm({ key: "", value: "", env: env || envs[0] || "dev", syncGroup: "", note: "", editing: false })}
            disabled={!projectId}
            style={primaryBtn}
          >
            키 추가
          </button>
        )}
      </div>

      {form && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 9, border: "1px solid var(--color-primary)", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input ref={envInput} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} disabled={form.editing} placeholder="환경 (dev·prod·local…)" style={{ ...inputStyle, width: 140 }} />
            <input ref={keyInput} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} disabled={form.editing} placeholder="KEY_NAME" style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
          </div>
          <input
            ref={valueInput}
            type="password"
            autoComplete="new-password"
            value={form.value}
            onChange={(e) => setForm({ ...form, value: e.target.value })}
            placeholder={form.editing ? "새 값 (비워 두면 값은 그대로 두고 syncGroup·메모만 바꿈)" : "값"}
            style={inputStyle}
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={form.syncGroup}
              onChange={(e) => setForm({ ...form, syncGroup: e.target.value })}
              placeholder="syncGroup (선택 · 비우면 해제)"
              title="같은 syncGroup 의 키(다른 프로젝트·환경 포함)는 값이 같아야 합니다. 다르면 경고합니다."
              style={{ ...inputStyle, flex: 1, minWidth: 0 }}
            />
            <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="메모 (선택)" style={{ ...inputStyle, flex: 2, minWidth: 0 }} />
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setForm(null)} style={ghostBtn}>취소</button>
            {(() => {
              const notReady = busy || !form.key.trim() || !form.env.trim() || (form.value === "" && !form.editing);
              return (
                <button
                  onClick={() => void save()}
                  aria-disabled={notReady}
                  style={{ ...primaryBtn, opacity: notReady ? 0.55 : 1, cursor: notReady ? "not-allowed" : "pointer" }}
                >
                  저장
                </button>
              );
            })()}
          </div>
        </div>
      )}

      {groups.some((g) => !g.consistent) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, fontWeight: 600, color: "var(--text-strong)" }}>
            <StatusPill label="syncGroup 불일치" color="orange" />
            같은 묶음인데 값이 서로 다른 키가 있습니다(워크스페이스 전체).
          </div>
          {groups.filter((g) => !g.consistent).map((g) => (
            <div key={g.name} style={{ fontSize: 12, color: "var(--text-body)" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600 }}>{g.name}</span>
              {" · "}
              {g.members.map((m) => `${m.projectName}/${m.env}/${m.key}`).join(", ")}
            </div>
          ))}
        </div>
      )}

      {vars.length === 0 ? (
        <p style={{ ...hint, marginTop: 0 }}>저장된 키가 없습니다.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {vars.map((v) => (
            <div
              key={v.id}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)" }}
            >
              <span style={{ display: "flex", color: "var(--color-primary)" }}>
                <Icon name="lock" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  <span style={{ fontFamily: "var(--font-mono)" }}>{v.key}</span>
                  <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--text-muted)", fontWeight: 500 }}>{v.env}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                  v{v.version} · {v.valueLength}자{v.syncGroup ? ` · ${v.syncGroup}` : ""} · {v.updatedByName ?? "-"} · {new Date(v.updatedAt).toLocaleString("ko-KR")}
                  {v.note ? ` · ${v.note}` : ""}
                </div>
                {v.sync && Object.keys(v.sync).length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                    {Object.entries(v.sync).map(([tid, st]) => {
                      const t = targetById.get(tid);
                      if (!t) return null;
                      const dr = v.drift?.[tid];
                      return (
                        <span key={tid} style={{ display: "inline-flex", gap: 4 }}>
                          <span title={`${t.summary} — 마지막 반영과 ${SYNC_PILL[st]?.label ?? st}`}>
                            <StatusPill label={`${TARGET_KIND_LABEL[t.kind]} ${SYNC_PILL[st]?.label ?? st}`} color={SYNC_PILL[st]?.color ?? "gray"} />
                          </span>
                          {dr && (
                            <span title={`${t.summary} — 마지막 점검 ${t.lastDriftAt ? new Date(t.lastDriftAt).toLocaleString("ko-KR") : "-"}`}>
                              <StatusPill label={DRIFT_PILL[dr]?.label ?? dr} color={DRIFT_PILL[dr]?.color ?? "gray"} />
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
                {revealed[v.id] !== undefined && (
                  <code style={{ display: "block", marginTop: 4, fontSize: 12, wordBreak: "break-all", color: "var(--text-body)" }}>{revealed[v.id]}</code>
                )}
              </div>
              {isAdmin && (
                <>
                  <button onClick={() => void toggleReveal(v.id)} style={ghostBtn}>{revealed[v.id] !== undefined ? "숨기기" : "값 보기"}</button>
                  <button
                    onClick={() => setForm({ key: v.key, value: "", env: v.env, syncGroup: v.syncGroup ?? "", note: v.note ?? "", editing: true })}
                    style={ghostBtn}
                  >
                    편집
                  </button>
                  <button onClick={() => void remove(v)} disabled={busy} style={{ ...ghostBtn, color: "#C0392B" }}>삭제</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, marginBottom: 6 }}>
        <span style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>반영 대상 ({targets.length})</span>
        {isAdmin && (
          <button
            onClick={() =>
              setTform({
                env: env || envs[0] || "dev", kind: "dotenv", path: "", prefix: "", region: "", profile: "",
                project: "", target: "development", scope: "", globalDir: "", repo: "", ghEnv: "", account: "",
              })
            }
            disabled={!projectId}
            style={ghostBtn}
          >
            대상 추가
          </button>
        )}
      </div>
      <p style={{ ...hint, marginTop: 0, marginBottom: 8 }}>
        반영은 CLI 로 합니다: <code>pnpm ws env push &lt;대상 id&gt; --apply --wait</code> — 로그인 계정을 먼저 확인하고, 사람이 승인해야 값이 나갑니다.
        {" "}원격과 실제로 같은지는 <code>pnpm ws env drift --all</code> 로 점검합니다(키별 상태만 기록).
      </p>

      {tform && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "10px 12px", borderRadius: 9, border: "1px solid var(--color-primary)", marginBottom: 10 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input value={tform.env} onChange={(e) => setTform({ ...tform, env: e.target.value })} placeholder="환경 (dev·prod·local…)" style={{ ...inputStyle, width: 140 }} />
            <select value={tform.kind} onChange={(e) => setTform({ ...tform, kind: e.target.value as TargetForm["kind"] })} style={{ ...inputStyle, flex: 1, minWidth: 0 }}>
              {Object.entries(TARGET_KIND_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </div>
          {tform.kind === "dotenv" && (
            <input value={tform.path} onChange={(e) => setTform({ ...tform, path: e.target.value })} placeholder="파일 절대 경로 (예: /Users/me/app/.env.local 또는 ~/app/.env)" style={inputStyle} />
          )}
          {tform.kind === "ssm" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input value={tform.prefix} onChange={(e) => setTform({ ...tform, prefix: e.target.value })} placeholder="SSM 경로 (예: /myapp/dev)" style={{ ...inputStyle, flex: 2, minWidth: 0 }} />
              <input value={tform.region} onChange={(e) => setTform({ ...tform, region: e.target.value })} placeholder="리전 (선택)" style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
              <input value={tform.profile} onChange={(e) => setTform({ ...tform, profile: e.target.value })} placeholder="AWS 프로필 (선택)" style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
            </div>
          )}
          {tform.kind === "vercel" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input value={tform.project} onChange={(e) => setTform({ ...tform, project: e.target.value })} placeholder="Vercel 프로젝트" style={{ ...inputStyle, flex: 2, minWidth: 0 }} />
              <select value={tform.target} onChange={(e) => setTform({ ...tform, target: e.target.value })} style={inputStyle}>
                <option value="development">development</option>
                <option value="preview">preview</option>
                <option value="production">production</option>
              </select>
              <input value={tform.scope} onChange={(e) => setTform({ ...tform, scope: e.target.value })} placeholder="팀 scope (선택)" style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
              <input value={tform.globalDir} onChange={(e) => setTform({ ...tform, globalDir: e.target.value })} placeholder="-Q 설정 폴더 (선택)" style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
            </div>
          )}
          {tform.kind === "gha" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input value={tform.repo} onChange={(e) => setTform({ ...tform, repo: e.target.value })} placeholder="저장소 (owner/repo)" style={{ ...inputStyle, flex: 2, minWidth: 0 }} />
              <input value={tform.ghEnv} onChange={(e) => setTform({ ...tform, ghEnv: e.target.value })} placeholder="GitHub environment (선택)" style={{ ...inputStyle, flex: 1, minWidth: 0 }} />
            </div>
          )}
          {tform.kind !== "dotenv" && (
            <input value={tform.account} onChange={(e) => setTform({ ...tform, account: e.target.value })} placeholder={TARGET_ACCOUNT_HINT[tform.kind]} style={inputStyle} />
          )}
          <p style={{ ...hint, marginTop: 0 }}>경로·이름·계정만 적습니다. 토큰이나 비밀번호처럼 보이는 값은 저장되지 않습니다.</p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={() => setTform(null)} style={ghostBtn}>취소</button>
            <button onClick={() => void saveTarget()} aria-disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.55 : 1, cursor: busy ? "not-allowed" : "pointer" }}>
              추가
            </button>
          </div>
        </div>
      )}

      {targets.length === 0 ? (
        <p style={{ ...hint, marginTop: 0 }}>등록된 반영 대상이 없습니다.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {targets.map((t) => (
            <div
              key={t.id}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-subtle)", background: "var(--surface-card)" }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {TARGET_KIND_LABEL[t.kind] ?? t.kind}
                  <span style={{ marginLeft: 8, fontSize: 11.5, color: "var(--text-muted)", fontWeight: 500 }}>{t.env}</span>
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t.summary} · {t.accountSummary} · {t.lastPushedAt ? `마지막 반영 ${new Date(t.lastPushedAt).toLocaleString("ko-KR")}` : "아직 반영 안 됨"}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2, fontSize: 11.5, color: "var(--text-muted)" }}>
                  {t.lastDriftAt ? (
                    <>
                      <span>마지막 점검 {new Date(t.lastDriftAt).toLocaleString("ko-KR")}</span>
                      <StatusPill label={`다름 ${t.driftIssues ?? 0}`} color={(t.driftIssues ?? 0) > 0 ? "orange" : "green"} />
                      {(() => {
                        const only = Object.entries(t.lastDrift ?? {}).filter(([, s]) => s === "remote_only").map(([k]) => k);
                        return only.length ? <span style={{ fontFamily: "var(--font-mono)" }}>원격에만: {only.join(", ")}</span> : null;
                      })()}
                    </>
                  ) : (
                    <span>점검 기록 없음 — <code>pnpm ws env drift {t.id}</code></span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{t.id}</div>
              </div>
              {isAdmin && (
                <button onClick={() => void removeTarget(t)} disabled={busy} style={{ ...ghostBtn, color: "#C0392B" }}>삭제</button>
              )}
            </div>
          ))}
        </div>
      )}

      {msg && <p style={{ ...hint, color: "var(--text-body)" }}>{msg}</p>}

      {isAdmin && logs.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ fontSize: 12.5, cursor: "pointer", color: "var(--text-muted)" }}>감사 로그 (최근 {logs.length}건)</summary>
          <ul style={{ maxHeight: 240, overflowY: "auto", margin: "6px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-body)" }}>
            {logs.map((l) => (
              <li key={l.id}>
                {new Date(l.at).toLocaleString("ko-KR")} · {l.actorName}
                {l.actorType === "agent" ? "(에이전트)" : ""} · {ENV_ACTION_LABEL[l.action] ?? l.action}
                {l.env ? ` · ${l.env}` : ""}
                {l.keys.length ? ` · ${l.keys.join(", ")}` : ""}
                {l.viaFunnel ? " · 외부 입구" : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Section>
  );
}

function Section({ title, id, children }: { title: string; id?: string; children: React.ReactNode }) {
  return (
    <div id={id} style={{ scrollMarginTop: 16, border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16, marginTop: 16 }}>
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

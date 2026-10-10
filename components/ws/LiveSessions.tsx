"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useIsMobile } from "@/lib/useIsMobile";
import { Pill, Table, Sub, td, rowStyle, hint, empty } from "./AiRoutes";

/* =====================================================================
   설정 › 라이브 세션·잠금(편집자 이상) — GET /api/sessions/live · DELETE /api/locks/<name>?force=1.
   지금 돌고 있는 Claude 세션이 어느 레포·브랜치·워크트리에서 무슨 태스크를 들고 있는지,
   공유 브랜치·배포 잠금을 누가 잡고 있는지 본다. 30초마다 새로 고침. 관리자는 잠금을 강제 해제할 수 있다.
   표·알약은 기존 설정 화면(AI 실행 경로·레슨 주입 점검) 패턴 그대로.
   ===================================================================== */

type Lock = {
  name: string;
  holderName: string;
  branch: string | null;
  cwd: string | null;
  note: string | null;
  takenAt: string;
  expiresAt: string;
  ageMin: number;
  remainingMin: number;
};
type Session = {
  id: string;
  externalId: string;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  cwd: string | null;
  project: string | null;
  agentName: string | null;
  startedAt: string;
  lastSeenAt: string;
  tasks: { id: string; title: string; board: string }[];
};
type Data = { windowHours: number; sessions: Session[]; locks: Lock[] };

const GOOD = "#12B886";
const WARN = "#F5A623";
const MUTED = "#9AA0A6";

function ago(iso: string, now: number): string {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분 전`;
}
function left(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)}시간 ${min % 60}분` : `${min}분`;
}
const lastFolder = (p: string | null) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : "—");

export default function LiveSessions({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const isMobile = useIsMobile();

  const load = useCallback(async () => {
    const res = await fetch("/api/sessions/live", { cache: "no-store" }).catch(() => null);
    const d = (await res?.json().catch(() => ({}))) as Data & { error?: string };
    if (!res || !res.ok) return void setError(d?.error ?? "불러오지 못했습니다.");
    setError(null);
    setData(d);
    setNow(Date.now());
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, [load]);

  async function forceRelease(name: string) {
    if (!window.confirm(`'${name}' 잠금을 강제로 풀까요? 보유자에게 알림이 갑니다.`)) return;
    setBusy(name);
    setMsg(null);
    try {
      const res = await fetch(`/api/locks/${encodeURIComponent(name)}?force=1`, { method: "DELETE" });
      const d = (await res.json().catch(() => ({}))) as { error?: string; released?: boolean };
      setMsg(res.ok ? (d.released ? `'${name}' 잠금을 풀었습니다.` : `'${name}' 은 이미 비어 있습니다.`) : (d.error ?? "풀지 못했습니다."));
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (error) return <p style={empty}>{error}</p>;
  if (!data) return <p style={empty}>불러오는 중…</p>;

  return (
    <div>
      <p style={{ ...hint, marginTop: 0, marginBottom: 12 }}>
        지금 돌고 있는 세션과 공유 브랜치·배포 잠금입니다. 마지막 활동이 {data.windowHours}시간 안인 세션만 보이고, 30초마다 새로 고칩니다. 잠금은 푸시를 막지 않고, 남의 잠금 위로 푸시하면 경고와 함께 보유자에게 알림이 갑니다. CLI: <code>pnpm ws sessions live</code> · <code>pnpm ws lock take banjang/develop</code>
      </p>

      <Sub label={`세션 ${data.sessions.length}개`}>
        {data.sessions.length === 0 ? (
          <p style={empty}>지금 돌고 있는 세션이 없습니다.</p>
        ) : isMobile ? (
          // 폰: 2열로 접는다 — 레포·브랜치·워크트리·에이전트는 한 줄 요약, 태스크는 그 아래(스킬 레지스트리 좁은 표와 같은 방식)
          <Table head={["세션 · 작업 중인 태스크", "마지막 활동"]} numericFrom={1}>
            {data.sessions.map((s) => (
              <tr key={s.id} style={rowStyle}>
                <td style={{ ...td, ...fill, verticalAlign: "top" }} title={s.cwd ?? undefined}>
                  <div style={{ ...oneLine, fontWeight: 600, color: "var(--text-strong)" }}>{s.repo ?? lastFolder(s.cwd)}</div>
                  {(s.branch || s.worktree || s.agentName) && (
                    <div style={{ ...oneLine, fontSize: 11.5, color: "var(--text-muted)" }}>
                      {[s.branch, s.worktree, s.agentName].filter(Boolean).join(" · ")}
                    </div>
                  )}
                  {s.tasks.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      <TaskList tasks={s.tasks} />
                    </div>
                  )}
                </td>
                <LastSeen iso={s.lastSeenAt} now={now} />
              </tr>
            ))}
          </Table>
        ) : (
          // 설정 카드는 데스크톱에서도 ~630px — 4열로 묶고(레포·에이전트 / 브랜치·워크트리) 긴 브랜치는 말줄임해 태스크 칸 폭을 지킨다
          <Table head={["레포 · 에이전트", "브랜치 · 워크트리", "작업 중인 태스크", "마지막 활동"]} numericFrom={3}>
            {data.sessions.map((s) => (
              <tr key={s.id} style={rowStyle}>
                <td style={{ ...td, verticalAlign: "top" }} title={s.cwd ?? undefined}>
                  <div style={{ ...oneLine, maxWidth: 140, fontWeight: 600, color: "var(--text-strong)" }}>{s.repo ?? lastFolder(s.cwd)}</div>
                  <div style={{ ...oneLine, maxWidth: 140, fontSize: 11.5, color: "var(--text-muted)" }}>{s.agentName ?? "—"}</div>
                </td>
                <td style={{ ...td, verticalAlign: "top" }}>
                  <div style={{ ...mono, ...oneLine, maxWidth: 160 }} title={s.branch ?? undefined}>{s.branch ?? "—"}</div>
                  <div style={{ ...mono, ...oneLine, maxWidth: 160, fontSize: 11.5, color: "var(--text-muted)" }} title={s.worktree ?? undefined}>
                    {s.worktree ?? (s.repo ? "본체" : "—")}
                  </div>
                </td>
                <td style={{ ...td, ...fill, verticalAlign: "top" }}>
                  {s.tasks.length === 0 ? <span style={{ color: "var(--text-muted)" }}>—</span> : <TaskList tasks={s.tasks} />}
                </td>
                <LastSeen iso={s.lastSeenAt} now={now} />
              </tr>
            ))}
          </Table>
        )}
      </Sub>

      <Sub label={`잠금 ${data.locks.length}개`}>
        {data.locks.length === 0 ? (
          <p style={empty}>잡힌 잠금이 없습니다.</p>
        ) : isMobile ? (
          // 폰: 이름 아래 보유·메모, 오른쪽에 남은 시간·강제 해제
          <Table head={["잠금 · 보유 · 메모", "남은 시간"]} numericFrom={1}>
            {data.locks.map((l) => (
              <tr key={l.name} style={rowStyle}>
                <td style={{ ...td, ...fill, verticalAlign: "top" }} title={[l.branch, l.cwd].filter(Boolean).join(" · ") || undefined}>
                  <div style={{ ...mono, ...oneLine, fontWeight: 600, color: "var(--text-strong)" }}>{l.name}</div>
                  <div style={{ ...oneLine, fontSize: 11.5, color: "var(--text-muted)" }}>
                    {l.holderName} · {l.ageMin}분 전부터
                  </div>
                  {l.note && <div style={{ overflowWrap: "anywhere" }}>{l.note}</div>}
                </td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", verticalAlign: "top" }} title={new Date(l.expiresAt).toLocaleString("ko-KR")}>
                  <Pill color={l.remainingMin <= 5 ? WARN : GOOD} label={left(l.remainingMin)} />
                  {isAdmin && (
                    <div style={{ marginTop: 6 }}>
                      <button onClick={() => void forceRelease(l.name)} disabled={busy === l.name} style={{ ...ghostBtn, color: "#C0392B" }}>
                        강제 해제
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Table head={isAdmin ? ["이름", "보유", "메모", "남은 시간", ""] : ["이름", "보유", "메모", "남은 시간"]} numericFrom={3}>
            {data.locks.map((l) => (
              <tr key={l.name} style={rowStyle}>
                <td style={{ ...td, ...mono, fontWeight: 600, color: "var(--text-strong)" }}>{l.name}</td>
                <td style={{ ...td, whiteSpace: "nowrap" }} title={[l.branch, l.cwd].filter(Boolean).join(" · ") || undefined}>
                  {l.holderName}
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{l.ageMin}분 전부터</div>
                </td>
                <td style={{ ...td, minWidth: 120, overflowWrap: "anywhere" }}>{l.note ?? <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }} title={new Date(l.expiresAt).toLocaleString("ko-KR")}>
                  <Pill color={l.remainingMin <= 5 ? WARN : GOOD} label={left(l.remainingMin)} />
                </td>
                {isAdmin && (
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={() => void forceRelease(l.name)} disabled={busy === l.name} style={{ ...ghostBtn, color: "#C0392B" }}>
                      강제 해제
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </Table>
        )}
        {msg && <p style={{ ...hint, color: "var(--text-body)" }}>{msg}</p>}
      </Sub>
    </div>
  );
}

/** 태스크 제목은 한 줄(넘치면 …, 전체는 title). 2개까지 보이고 나머지는 "외 N개" 로 접는다. */
const TASKS_SHOWN = 2;
function TaskList({ tasks }: { tasks: Session["tasks"] }) {
  const link = (t: Session["tasks"][number]) => (
    <a key={t.id} href={`/p/${t.board}`} title={t.title} style={{ ...oneLine, display: "block", color: "var(--text-body)" }}>
      {t.title}
    </a>
  );
  const rest = tasks.slice(TASKS_SHOWN);
  return (
    <>
      {tasks.slice(0, TASKS_SHOWN).map(link)}
      {rest.length > 0 && (
        <details>
          <summary style={{ fontSize: 12, cursor: "pointer", color: "var(--text-muted)" }}>외 {rest.length}개</summary>
          {rest.map(link)}
        </details>
      )}
    </>
  );
}

function LastSeen({ iso, now }: { iso: string; now: number }) {
  return (
    <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", verticalAlign: "top" }} title={new Date(iso).toLocaleString("ko-KR")}>
      <Pill color={now - new Date(iso).getTime() < 15 * 60000 ? GOOD : MUTED} label={ago(iso, now)} />
    </td>
  );
}

const oneLine: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
/** 남는 폭을 다 쓰되 내용 때문에 표가 넓어지지 않게(max-width:0 + width:100% — 안쪽 한 줄 말줄임이 먹는다). */
const fill: CSSProperties = { width: "100%", maxWidth: 0 };
const mono: CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)", fontSize: 12, whiteSpace: "nowrap" };
const ghostBtn: CSSProperties = {
  padding: "6px 14px", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", whiteSpace: "nowrap",
};

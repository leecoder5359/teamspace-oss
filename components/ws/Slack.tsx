"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* =====================================================================
   슬랙 연동 설정 화면 — 봇 토큰 붙여넣기 연결 + 테스트 발송(PoC).
   토큰은 사용자가 입력 → /api/slack/connect 로 전송 → 암호화 저장.
   ===================================================================== */

type Status = {
  connected: boolean;
  source?: "env" | "db";
  teamId?: string;
  teamName?: string;
  defaultChannelId?: string | null;
};

export default function Slack() {
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState("");
  const [channel, setChannel] = useState("");
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  async function load() {
    const res = await fetch("/api/slack", { cache: "no-store" });
    const data = (await res.json()) as Status;
    setStatus(data);
    setChannel(data.defaultChannelId ?? "");
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    void (async () => {
      const r = await fetch("/api/slack/channels", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { ok: boolean; channels?: { id: string; name: string }[] };
        if (d.ok && d.channels) setChannels(d.channels);
      }
    })();
  }, []);

  async function connect() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/slack/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: token.trim(), defaultChannelId: channel.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg({ tone: "err", text: data.error ?? "연결 실패" });
      } else {
        setToken("");
        setMsg({ tone: "ok", text: `연결됨: ${data.teamName ?? data.teamId ?? "슬랙"}` });
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/slack/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: channel.trim() || undefined }),
      });
      const data = await res.json();
      setMsg(
        data.ok
          ? { tone: "ok", text: "테스트 메시지를 보냈습니다." }
          : { tone: "err", text: `발송 실패: ${data.error}` },
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setMsg(null);
    try {
      await fetch("/api/slack", { method: "DELETE" });
      setMsg({ tone: "ok", text: "연결을 해제했습니다." });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function saveChannel() {
    // PATCH /api/slack 은 admin 전용이라 editor 는 403 인데, 종전엔 응답을 안 보고
    // 무조건 "저장했습니다" 라고 말했다(전수조사 D4).
    const res = await fetch("/api/slack", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultChannelId: channel.trim() || null }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg({ tone: "err", text: d.error ?? "기본 채널을 저장하지 못했습니다." });
      return;
    }
    setMsg({ tone: "ok", text: "기본 채널을 저장했습니다." });
  }

  if (status === null) {
    return <div className="ws-db" style={{ padding: 40 }} />;
  }

  return (
    <div className="ws-db" style={{ maxWidth: 720 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="slack" /> 슬랙 연동
      </h1>

      {/* 채널 피커(공유 datalist). channels:read 스코프 있을 때만 채워짐. */}
      <datalist id="ws-slack-channels">
        {channels.map((c) => (
          <option key={c.id} value={c.id} label={`#${c.name}`} />
        ))}
      </datalist>

      {msg && (
        <div
          role="status"
          style={{
            margin: "12px 0",
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
            background: msg.tone === "ok" ? "var(--color-primary-weak)" : "#fde8e8",
            color: msg.tone === "ok" ? "var(--color-primary)" : "#c0392b",
          }}
        >
          {msg.text}
        </div>
      )}

      {!status.connected ? (
        <div style={{ marginTop: 16 }}>
          <ol style={{ color: "var(--text-muted)", fontSize: 13, lineHeight: 2, paddingLeft: 18 }}>
            <li>api.slack.com 에서 Slack App 생성</li>
            <li>
              OAuth &amp; Permissions → 봇 스코프 <code>chat:write</code> 추가
            </li>
            <li>
              워크스페이스에 설치 후 <b>Bot User OAuth Token</b>(<code>xoxb-…</code>) 복사
            </li>
            <li>
              봇을 알림 보낼 채널에 초대(<code>/invite @앱이름</code>)
            </li>
          </ol>
          <label style={labelStyle}>봇 토큰 (xoxb-…)</label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="xoxb-..."
            style={inputStyle}
          />
          <label style={labelStyle}>기본 채널 (선택 — 채널 선택 또는 ID 입력)</label>
          <input
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            placeholder="채널 선택 또는 C..."
            list="ws-slack-channels"
            style={inputStyle}
          />
          <button onClick={connect} disabled={busy || !token.trim()} style={primaryBtn}>
            연결
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="check" /> <b>{status.teamName ?? status.teamId ?? "슬랙"}</b> 워크스페이스에 연결됨
          </div>

          {status.source === "env" ? (
            <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.8 }}>
              <code>AUTH_SLACK_BOT_TOKEN</code> 환경변수로 설정됨. 기본 채널은{" "}
              <code>AUTH_SLACK_DEFAULT_CHANNEL</code>{" "}
              {status.defaultChannelId ? (
                <>
                  (<code>{status.defaultChannelId}</code>)
                </>
              ) : (
                "(미설정)"
              )}
              . 토큰/채널 변경은 <code>.env</code> 수정 후 서버 재시작.
            </p>
          ) : (
            <>
              <label style={labelStyle}>기본 채널</label>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  placeholder="채널 선택 또는 C..."
                  list="ws-slack-channels"
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button onClick={saveChannel} disabled={busy} style={secondaryBtn}>
                  저장
                </button>
              </div>
            </>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button onClick={sendTest} disabled={busy} style={primaryBtn}>
              테스트 메시지 보내기
            </button>
            {status.source !== "env" && (
              <button onClick={disconnect} disabled={busy} style={dangerBtn}>
                연결 해제
              </button>
            )}
          </div>
        </div>
      )}

      <NotifRules />
      <SendLog />
    </div>
  );
}

/* ── 자동 알림 규칙 (도메인 이벤트 → 슬랙) ── */
type Project = { id: string; name: string };
type Rule = { id: string; event: string; target: string; targetId: string; enabled: boolean; projectId: string | null };
const EVENT_LABEL: Record<string, string> = { task_created: "태스크 생성", task_status: "상태 변경", task_assigned: "담당자 배정", task_due: "마감 임박", comment_added: "댓글 작성", doc_saved: "문서 저장" };

function NotifRules() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [event, setEvent] = useState("task_status");
  const [channel, setChannel] = useState("");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await fetch("/api/notif-rules", { cache: "no-store" });
    if (res.ok) setRules(((await res.json()) as { rules: Rule[] }).rules);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    void (async () => {
      const r = await fetch("/api/projects", { cache: "no-store" });
      if (r.ok) {
        const d = (await r.json()) as { projects: Project[] };
        setProjects(d.projects);
      }
    })();
  }, []);

  async function add() {
    if (!channel.trim() || busy) return;
    setBusy(true);
    try {
      const body: { event: string; targetId: string; projectId?: string } = { event, targetId: channel.trim() };
      if (projectId) body.projectId = projectId;
      const res = await fetch("/api/notif-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) { setChannel(""); setProjectId(""); await load(); }
    } finally {
      setBusy(false);
    }
  }
  async function toggle(r: Rule) {
    await fetch(`/api/notif-rules/${r.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !r.enabled }) });
    await load();
  }
  async function remove(id: string) {
    await fetch(`/api/notif-rules/${id}`, { method: "DELETE" });
    await load();
  }

  if (rules === null) return null;

  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", margin: "0 0 4px" }}>자동 알림 규칙</h2>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: "0 0 12px" }}>조건이 충족되면 선택한 채널로 자동 발송돼요(발송 내역에 기록).</p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: rules.length ? 14 : 0 }}>
        <select value={event} onChange={(e) => setEvent(e.target.value)} style={{ ...inputStyle, width: "auto", marginTop: 0 }} aria-label="이벤트">
          {Object.entries(EVENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ ...inputStyle, width: "auto", marginTop: 0 }} aria-label="프로젝트">
          <option value="">전체 프로젝트(기본)</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={channel} onChange={(e) => setChannel(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} placeholder="채널 선택 또는 #qa-알림/C0123" list="ws-slack-channels" style={{ ...inputStyle, marginTop: 0, flex: "1 1 200px" }} aria-label="채널" />
        <button onClick={() => void add()} disabled={busy || !channel.trim()} style={{ ...secondaryBtn, marginTop: 0 }}>규칙 추가</button>
      </div>

      {rules.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rules.map((r) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "10px 12px", background: "var(--surface-card)", opacity: r.enabled ? 1 : 0.55 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, padding: "2px 8px", borderRadius: 6, background: "var(--surface-sunken)", color: "var(--text-sub)" }}>{EVENT_LABEL[r.event] ?? r.event}</span>
              <span style={{ fontSize: 11.5, padding: "2px 8px", borderRadius: 6, background: "var(--surface-sunken)", color: "var(--text-sub)" }}>{r.projectId ? (projects.find((p) => p.id === r.projectId)?.name ?? r.projectId) : "전역"}</span>
              <Icon name="arrowRight" size={13} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", flex: 1, minWidth: 0 }}>{r.targetId}</span>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--text-muted)", cursor: "pointer" }}>
                <input type="checkbox" checked={r.enabled} onChange={() => void toggle(r)} /> 활성
              </label>
              <button onClick={() => void remove(r.id)} title="삭제" aria-label="규칙 삭제" style={{ border: "none", background: "transparent", color: "var(--color-danger)", cursor: "pointer", padding: 2, display: "flex" }}><Icon name="close" size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 알림 발송 내역 (design slack.jsx) ── */
type LogRow = { id: string; channel: string; text: string; kind: string; state: string; createdAt: string };
const KIND_LABEL: Record<string, string> = { manual: "수동", approval: "승인", reminder: "리마인더", test: "테스트" };
const KIND_COLOR: Record<string, string> = { manual: "#8B95A1", approval: "#2F62FF", reminder: "#7165E3", test: "#12B886" };

function dayLabel(iso: string): string {
  const d = new Date(iso); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (diff === 0) return "오늘";
  if (diff === -1) return "어제";
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function SendLog() {
  const [data, setData] = useState<{ logs: LogRow[]; total: number; failed: number; sentToday: number } | null>(null);
  const [kind, setKind] = useState<"all" | string>("all");

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/slack/log?kind=${kind}`, { cache: "no-store" });
      if (res.ok) setData((await res.json()) as { logs: LogRow[]; total: number; failed: number; sentToday: number });
    })();
  }, [kind]);

  if (!data) return null;

  // 날짜별 그룹(이미 최신순)
  const groups: { key: string; items: LogRow[] }[] = [];
  for (const l of data.logs) {
    const key = l.createdAt.slice(0, 10);
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push((g = { key, items: [] }));
    g.items.push(l);
  }

  const tabs: [string, string][] = [["all", "전체"], ["manual", "수동"], ["approval", "승인"], ["reminder", "리마인더"], ["test", "테스트"]];

  return (
    <div style={{ marginTop: 28 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", margin: "0 0 12px" }}>알림 발송 내역</h2>

      {/* 요약 스탯 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        {([["오늘 전송", data.sentToday, "#12B886"], ["전체 발송", data.total, "#2F62FF"], ["전송 실패", data.failed, data.failed ? "#F0494E" : "#8B95A1"]] as [string, number, string][]).map(([l, v, c]) => (
          <div key={l} style={{ flex: "1 1 130px", border: "1px solid var(--border-subtle)", borderRadius: 12, padding: "12px 16px", background: "var(--surface-card)", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ width: 3, alignSelf: "stretch", borderRadius: 999, background: c }} />
            <div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-strong)", lineHeight: 1 }}>{v}</div>
              <div style={{ fontSize: 12, color: "var(--text-sub)", marginTop: 3 }}>{l}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 유형 필터 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {tabs.map(([k, lbl]) => (
          <button key={k} onClick={() => setKind(k)} className="ws-btn-soft" style={{ fontWeight: kind === k ? 700 : 500, borderColor: kind === k ? "var(--color-primary)" : undefined, color: kind === k ? "var(--color-primary)" : undefined }}>{lbl}</button>
        ))}
      </div>

      {data.logs.length === 0 ? (
        <div style={{ textAlign: "center", padding: 32, color: "var(--text-muted)", fontSize: 13, border: "1px dashed var(--border-subtle)", borderRadius: 12 }}>아직 발송된 알림이 없어요.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {groups.map((g) => (
            <div key={g.key}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)", padding: "0 4px 6px" }}>{dayLabel(g.items[0].createdAt)}</div>
              <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", overflow: "hidden" }}>
                {g.items.map((l, i) => {
                  const failed = l.state === "failed";
                  const kc = KIND_COLOR[l.kind] ?? "#8B95A1";
                  return (
                    <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderTop: i ? "1px solid var(--border-subtle)" : "none" }}>
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: 8, flex: "0 0 auto", background: "var(--surface-sunken)", color: "var(--text-sub)" }}><Icon name="hash" size={14} /></span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-strong)" }}>{l.channel}</span>
                          <span style={{ fontSize: 10.5, fontWeight: 700, padding: "1px 6px", borderRadius: 5, background: `color-mix(in srgb, ${kc} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${kc} 74%, var(--text-strong))` }}>{KIND_LABEL[l.kind] ?? l.kind}</span>
                        </div>
                        <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.text}</div>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, flex: "0 0 auto" }}>
                        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{new Date(l.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: failed ? "#F0494E" : "#12B886" }}>
                          <Icon name={failed ? "alert" : "check"} size={12} />{failed ? "실패" : "전송됨"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12.5,
  color: "var(--text-muted)",
  marginTop: 12,
};
const inputStyle: CSSProperties = {
  width: "100%",
  marginTop: 4,
  padding: "9px 12px",
  borderRadius: 9,
  border: "1px solid var(--border-default)",
  background: "var(--surface-card)",
  color: "var(--text-strong)",
  fontSize: 13,
};
const baseBtn: CSSProperties = {
  marginTop: 16,
  padding: "9px 16px",
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid transparent",
};
const primaryBtn: CSSProperties = { ...baseBtn, background: "var(--color-primary)", color: "#fff" };
const secondaryBtn: CSSProperties = {
  ...baseBtn,
  marginTop: 0,
  background: "var(--surface-card)",
  border: "1px solid var(--border-default)",
  color: "var(--text-strong)",
};
const dangerBtn: CSSProperties = {
  ...baseBtn,
  background: "transparent",
  border: "1px solid var(--border-default)",
  color: "#c0392b",
};

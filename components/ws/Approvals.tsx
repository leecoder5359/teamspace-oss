"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";

/* =====================================================================
   승인 대기 인박스 (design app/approvals.jsx 포팅) — 에이전트/앱이 만든
   승인 요청을 카드로 보여주고, 승인/추가요청/거부. 슬랙 인터랙티브와 동일 결정 적용.
   ===================================================================== */

type Status = "pending" | "approved" | "rejected" | "additional";
type Kind = "general" | "status" | "triage" | "doc" | "project" | "deploy";
type Approval = {
  id: string;
  title: string;
  body: string;
  kind: Kind;
  highRisk: boolean;
  status: Status;
  responseText: string | null;
  createdAt: string;
  respondedAt: string | null;
};

const STATUS_META: Record<Status, { label: string; color: string }> = {
  pending: { label: "대기 중", color: "#F5A623" },
  approved: { label: "승인됨", color: "#12B886" },
  rejected: { label: "거부됨", color: "#F0494E" },
  additional: { label: "추가 요청", color: "#2F62FF" },
};

const KIND_META: Record<Kind, { label: string; color: string; icon: IconName } | null> = {
  general: null,
  status: { label: "상태 변경", color: "#12B886", icon: "refresh" },
  triage: { label: "분류 제안", color: "#2F62FF", icon: "tag" },
  doc: { label: "문서 초안", color: "#7165E3", icon: "doc" },
  project: { label: "프로젝트화", color: "#F5A623", icon: "folder" },
  deploy: { label: "배포 컨펌", color: "#F0494E", icon: "alert" },
};

export default function Approvals() {
  const [list, setList] = useState<Approval[] | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<Kind>("general");
  const [highRisk, setHighRisk] = useState(false);
  const [autoLow, setAutoLow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/approvals", { cache: "no-store" });
    const data = (await res.json()) as { approvals: Approval[] };
    setList(data.approvals);
  }

  // 낮은 위험 자동 승인: 켜면 대기 중인 저위험 건을 일괄 승인
  async function onAutoLow(checked: boolean) {
    setAutoLow(checked);
    if (!checked || !list) return;
    const lows = list.filter((a) => a.status === "pending" && !a.highRisk);
    if (lows.length === 0) return;
    setBusy(true);
    try {
      await Promise.all(
        lows.map((a) =>
          fetch(`/api/approvals/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "approved" }) }),
        ),
      );
      setMsg(`낮은 위험 ${lows.length}건을 자동 승인했어요.`);
      await load();
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function createReq() {
    if (!title.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), kind, highRisk }),
      });
      const data = await res.json();
      setMsg(data.sent ? "슬랙으로 승인 요청을 보냈습니다." : `생성됨(슬랙 미발송: ${data.error})`);
      setTitle("");
      setBody("");
      setKind("general");
      setHighRisk(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function decide(id: string, status: Status, responseText?: string) {
    setBusy(true);
    try {
      await fetch(`/api/approvals/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, responseText }),
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (list === null) return <div className="ws-db" style={{ padding: 40 }} />;

  const pending = list.filter((a) => a.status === "pending");
  const done = list.filter((a) => a.status !== "pending");
  const lowPendingCount = pending.filter((a) => !a.highRisk).length;

  return (
    <div className="ws-db" style={{ maxWidth: 820 }}>
      {/* 헤더 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", marginBottom: 16, flexWrap: "wrap" }}>
        <div style={aiBadge}>AI</div>
        <div style={{ flex: 1, minWidth: 160 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text-strong)" }}>승인 대기 인박스</div>
          <div style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 2 }}>
            중요한 건만 컨펌하면 돼요. 승인/거부/추가요청은 슬랙(#workspace-confirm)에서도 가능합니다.
          </div>
        </div>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, color: "var(--text-sub)", cursor: "pointer", flex: "0 0 auto" }} title="대기 중인 저위험 건을 일괄 승인">
          <input type="checkbox" checked={autoLow} disabled={busy} onChange={(e) => void onAutoLow(e.target.checked)} />
          낮은 위험 자동 승인{lowPendingCount ? ` (${lowPendingCount})` : ""}
        </label>
      </div>

      {/* 새 승인 요청(테스트/수동) */}
      <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="승인 요청 제목" style={inputStyle} />
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="내용(선택)" rows={2} style={{ ...inputStyle, marginTop: 8, resize: "vertical" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} style={{ ...inputStyle, width: "auto" }}>
            <option value="general">유형: 일반</option>
            <option value="status">상태 변경</option>
            <option value="triage">분류 제안</option>
            <option value="doc">문서 초안</option>
            <option value="project">프로젝트화</option>
            <option value="deploy">배포 컨펌</option>
          </select>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-sub)", cursor: "pointer" }}>
            <input type="checkbox" checked={highRisk} onChange={(e) => setHighRisk(e.target.checked)} /> 컨펌 필요(높은 위험)
          </label>
          <span style={{ flex: 1 }} />
          <button onClick={createReq} disabled={busy || !title.trim()} style={primaryBtn}>슬랙으로 승인 요청 보내기</button>
        </div>
        {msg && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 8 }}>{msg}</div>}
      </div>

      {list.length === 0 ? (
        <div className="ws-empty">
          <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--surface-sunken)", color: "var(--text-disabled)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
            <Icon name="inbox" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-body)" }}>승인 대기 중인 제안이 없어요</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 5 }}>새 요청을 만들거나, 에이전트가 제안하면 여기로 알려드릴게요.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {[...pending, ...done].map((a) => (
            <Card key={a.id} a={a} busy={busy} onDecide={decide} />
          ))}
        </div>
      )}
    </div>
  );
}

function Card({ a, busy, onDecide }: { a: Approval; busy: boolean; onDecide: (id: string, s: Status, t?: string) => void }) {
  const [mode, setMode] = useState<null | "reject" | "additional">(null);
  const [text, setText] = useState("");
  const s = STATUS_META[a.status];
  const k = KIND_META[a.kind];
  const pending = a.status === "pending";
  const chip = (label: string, color: string, icon?: IconName) => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, height: 21, padding: "0 8px", borderRadius: 6, fontSize: 11.5, fontWeight: 700, background: `color-mix(in srgb, ${color} 13%, var(--surface-card))`, color: `color-mix(in srgb, ${color} 74%, var(--text-strong))` }}>
      {icon && <Icon name={icon} size={12} />}{label}
    </span>
  );

  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 14, background: "var(--surface-card)", padding: 18, boxShadow: "var(--shadow-xs)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={aiBadge}>AI</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>제안 · {new Date(a.createdAt).toLocaleString("ko-KR")}</div>
          <h3 style={{ margin: "3px 0 0", fontSize: 15.5, fontWeight: 700, color: "var(--text-strong)", letterSpacing: "-0.01em" }}>{a.title}</h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {k && chip(k.label, k.color, k.icon)}
          {a.highRisk ? chip("컨펌 필요", "#E0900F", "alert") : chip("낮은 위험", "#9AA0A6", "circle")}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 24, padding: "0 10px", borderRadius: 999, fontSize: 12, fontWeight: 700, background: `color-mix(in srgb, ${s.color} 14%, var(--surface-card))`, color: `color-mix(in srgb, ${s.color} 78%, var(--text-strong))` }}>
            <span style={{ width: 7, height: 7, borderRadius: 999, background: s.color }} />{s.label}
          </span>
        </div>
      </div>

      {a.body && <p style={{ fontSize: 13, color: "var(--text-sub)", lineHeight: 1.55, margin: "12px 0 0", whiteSpace: "pre-wrap" }}>{a.body}</p>}
      {a.responseText && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "var(--surface-sunken)", fontSize: 12.5, color: "var(--text-body)" }}>
          <b>{a.status === "rejected" ? "거부 사유" : "추가 요청"}:</b> {a.responseText}
        </div>
      )}

      {pending && mode === null && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <span style={{ flex: 1 }} />
          <button className="ws-btn-soft" disabled={busy} onClick={() => setMode("reject")}><Icon name="close" /> 거부</button>
          <button className="ws-btn-soft" disabled={busy} onClick={() => setMode("additional")}><Icon name="comment" /> 추가요청</button>
          <button style={primaryBtn} disabled={busy} onClick={() => onDecide(a.id, "approved")}><Icon name="check" /> 승인</button>
        </div>
      )}

      {pending && mode !== null && (
        <div style={{ marginTop: 14 }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} autoFocus placeholder={mode === "reject" ? "거부 사유" : "추가 요청 내용"} style={{ ...inputStyle, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <span style={{ flex: 1 }} />
            <button className="ws-btn-soft" disabled={busy} onClick={() => { setMode(null); setText(""); }}>취소</button>
            <button style={primaryBtn} disabled={busy} onClick={() => onDecide(a.id, mode === "reject" ? "rejected" : "additional", text)}>보내기</button>
          </div>
        </div>
      )}
    </div>
  );
}

const aiBadge: CSSProperties = {
  width: 34, height: 34, borderRadius: 10, flex: "0 0 auto",
  background: "var(--color-primary-weak)", color: "var(--color-primary)",
  display: "flex", alignItems: "center", justifyContent: "center",
  fontSize: 12, fontWeight: 800,
};
const inputStyle: CSSProperties = {
  width: "100%", padding: "9px 12px", borderRadius: 9,
  border: "1px solid var(--border-default)", background: "var(--surface-card)",
  color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit",
};
const primaryBtn: CSSProperties = {
  padding: "8px 14px", borderRadius: 9, fontSize: 13, fontWeight: 600,
  cursor: "pointer", border: "1px solid transparent",
  background: "var(--color-primary)", color: "#fff",
  display: "inline-flex", alignItems: "center", gap: 5,
};

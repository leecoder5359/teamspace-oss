"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";

/* =====================================================================
   리마인더 — 특정 시각(once) 예약 알림. 기존 Schedule API(/api/schedules) 사용.
   슬랙 발송은 워커/채널 설정 시 동작(채널 없으면 pending). 여기선 등록·목록·삭제.
   ===================================================================== */

type Template = { text?: string };
type Schedule = {
  id: string;
  spec: string; // ISO datetime
  template: Template;
  channelId: string;
  status: string;
  createdAt: string;
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ko-KR");
}

export default function Reminders() {
  const [list, setList] = useState<Schedule[] | null>(null);
  const [text, setText] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/schedules", { cache: "no-store" });
    const data = (await res.json()) as { schedules: Schedule[] };
    setList(data.schedules);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function create() {
    if (!text.trim() || !when) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text.trim(), remindAt: when }),
      });
      if (!res.ok) {
        const d = await res.json();
        setErr(d.error ?? "등록 실패");
      } else {
        setText("");
        setWhen("");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch(`/api/schedules/${id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (list === null) return <div className="ws-db" style={{ padding: 40 }} />;

  return (
    <div className="ws-db" style={{ maxWidth: 760 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="bell" /> 리마인더
      </h1>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
        지정 시각에 알림을 보냅니다. 슬랙 채널이 설정되면 해당 채널로 발송돼요.
      </p>

      {/* 등록 */}
      <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, margin: "16px 0" }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="리마인더 내용" style={inputStyle} />
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
          <button onClick={create} disabled={busy || !text.trim() || !when} style={primaryBtn}>
            <Icon name="plus" /> 등록
          </button>
        </div>
        {err && <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 8 }}>{err}</div>}
      </div>

      {/* 목록 */}
      {list.length === 0 ? (
        <div className="ws-empty">
          <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--surface-sunken)", color: "var(--text-disabled)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
            <Icon name="bell" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-body)" }}>예약된 리마인더가 없어요</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 5 }}>위에서 시각과 내용을 정해 등록해 보세요.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((s) => (
            <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)" }}>
              <span style={{ display: "flex", color: "var(--color-primary)" }}>
                <Icon name="clock" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: "var(--text-strong)", fontWeight: 600 }}>{s.template?.text ?? "(내용 없음)"}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  {fmt(s.spec)}
                  {s.channelId ? "" : " · 채널 미설정"}
                </div>
              </div>
              <button className="ws-btn-soft" disabled={busy} onClick={() => remove(s.id)} title="삭제">
                <Icon name="close" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: 9,
  border: "1px solid var(--border-default)",
  background: "var(--surface-card)",
  color: "var(--text-strong)",
  fontSize: 13,
  fontFamily: "inherit",
};
const primaryBtn: CSSProperties = {
  padding: "9px 16px",
  borderRadius: 9,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  border: "1px solid transparent",
  background: "var(--color-primary)",
  color: "#fff",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  whiteSpace: "nowrap",
};

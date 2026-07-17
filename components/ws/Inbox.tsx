"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { useAutoRefresh } from "@/lib/useAutoRefresh";

/* 알림 인박스 (W6 inv-4): 배정·멘션·승인·마감 알림 목록 + 읽음 처리. */

type Notif = {
  id: string;
  type: string;
  title: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

const TYPE_ICON: Record<string, IconName> = {
  assigned: "user",
  mention: "comment",
  approval: "inbox",
  due: "clock",
  comment: "comment",
};

export default function Inbox() {
  const [items, setItems] = useState<Notif[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const load = useCallback(async () => {
    const r = await fetch("/api/notifications?limit=100", { cache: "no-store" });
    if (r.ok) {
      const d = (await r.json()) as { notifications: Notif[]; unread: number };
      setItems(d.notifications);
      setUnread(d.unread);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  useAutoRefresh(load);

  async function open(n: Notif) {
    if (!n.readAt) await fetch(`/api/notifications/${n.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ read: true }) });
    if (n.link) router.push(n.link);
    else void load();
  }

  async function readAll() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readAll: true }) });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ws-db" style={{ maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
          <Icon name="inbox" /> 알림
          {unread > 0 && <span style={{ fontSize: 13, color: "var(--color-primary)", fontWeight: 700 }}>미읽음 {unread}</span>}
        </h1>
        <span style={{ flex: 1 }} />
        {unread > 0 && (
          <button className="ws-btn-soft" onClick={readAll} disabled={busy}>모두 읽음</button>
        )}
      </div>

      {items === null ? (
        <div className="ws-empty-hint" style={{ marginTop: 24 }}>불러오는 중…</div>
      ) : items.length === 0 ? (
        <div className="ws-empty-hint" style={{ marginTop: 24 }}>알림이 없습니다. 배정·멘션·승인·마감 알림이 여기에 쌓입니다.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 18 }}>
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => void open(n)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 10,
                border: `1px solid ${n.readAt ? "var(--border-subtle)" : "var(--color-primary)"}`,
                background: "var(--surface-card)", cursor: "pointer", textAlign: "left",
                opacity: n.readAt ? 0.65 : 1, font: "inherit", color: "inherit", width: "100%",
              }}
            >
              <span style={{ display: "flex", color: "var(--color-primary)" }}>
                <Icon name={TYPE_ICON[n.type] ?? "bell"} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: n.readAt ? 500 : 700, color: "var(--text-strong)" }}>{n.title}</div>
                <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{new Date(n.createdAt).toLocaleString("ko-KR")}</div>
              </div>
              {!n.readAt && <span style={{ width: 8, height: 8, borderRadius: 4, background: "var(--color-primary)", flexShrink: 0 }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

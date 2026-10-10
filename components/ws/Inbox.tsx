"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { useAutoRefresh } from "@/lib/useAutoRefresh";
import { groupNotifications } from "@/lib/notifGroup";

/* 알림 인박스 (W6 inv-4): 배정·멘션·승인·마감·제안·공유 알림 목록 + 읽음 처리. */

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
  proposal: "inbox",
  shared: "lock",
};

/** 종류 칩 — key 는 GET /api/notifications?type= 값("all" 은 필터 없음). */
const TYPE_TABS: [string, string][] = [["all", "전체"], ["approval", "승인"], ["assigned", "배정"], ["mention", "멘션"], ["due", "마감"], ["proposal", "제안"], ["shared", "공유"]];

const GROUP_KEY = "ws.inbox.group";
const GROUP_AUTO_MIN = 20;
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_TABS.filter(([k]) => k !== "all"));

function readGroupPref(): boolean | null {
  try {
    const v = localStorage.getItem(GROUP_KEY);
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

export default function Inbox() {
  const [items, setItems] = useState<Notif[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [byType, setByType] = useState<Record<string, number>>({});
  const [type, setType] = useState("all");
  const [busy, setBusy] = useState(false);
  // 묶어 보기: 저장된 선택(null=없음) → 없으면 전체 미읽음이 20건 초과일 때 자동 켬.
  // 기준은 서버의 전역 unread — 종류 칩으로 목록이 줄어도, 100건 상한에 잘려도 흔들리지 않는다.
  const [pref, setPref] = useState<boolean | null>(null);
  const [open_, setOpen] = useState<Set<string>>(new Set());
  const router = useRouter();
  const grouped = pref ?? (items !== null && unread > GROUP_AUTO_MIN);
  const groups = useMemo(() => (grouped && items ? groupNotifications(items) : []), [grouped, items]);
  const byId = useMemo(() => new Map((items ?? []).map((n) => [n.id, n])), [items]);
  function toggleGroup() {
    const next = !grouped;
    setPref(next);
    try { localStorage.setItem(GROUP_KEY, next ? "1" : "0"); } catch { /* 저장 불가 환경은 세션 내에서만 유지 */ }
  }
  async function readGroup(ids: string[]) {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) });
      await load();
    } finally {
      setBusy(false);
    }
  }
  // 요청 순번 — 칩을 바꾼 뒤 늦게 도착한 이전 요청(30초 자동 새로고침 등)이 목록을 덮지 않게 마지막 요청만 반영한다
  const reqSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    const r = await fetch(`/api/notifications?limit=100${type === "all" ? "" : `&type=${type}`}`, { cache: "no-store" });
    if (seq !== reqSeq.current) return;
    if (r.ok) {
      const d = (await r.json()) as { notifications: Notif[]; unread: number; byType?: Record<string, number> };
      if (seq !== reqSeq.current) return;
      // localStorage 는 하이드레이션 뒤(첫 응답 시점)에 읽는다 — SSR 마크업과 어긋나지 않게
      setPref((p) => p ?? readGroupPref());
      setItems(d.notifications);
      setUnread(d.unread);
      setByType(d.byType ?? {});
    }
  }, [type]);
  useEffect(() => {
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
        <button className="ws-btn-soft" onClick={toggleGroup} aria-pressed={grouped}
          style={{ fontWeight: grouped ? 700 : 500, borderColor: grouped ? "var(--color-primary)" : undefined, color: grouped ? "var(--color-primary)" : undefined }}>
          묶어 보기
        </button>
        {unread > 0 && (
          <button className="ws-btn-soft" onClick={readAll} disabled={busy}>모두 읽음</button>
        )}
      </div>

      {/* 종류 필터 — 슬랙 '알림 발송 내역' 유형 필터와 같은 칩 모양, 미읽음 수는 ws-nav-count */}
      <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
        {TYPE_TABS.map(([k, lbl]) => {
          const n = k === "all" ? unread : byType[k] ?? 0;
          const on = type === k;
          return (
            <button
              key={k}
              onClick={() => setType(k)}
              aria-pressed={on}
              className="ws-btn-soft"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: on ? 700 : 500, borderColor: on ? "var(--color-primary)" : undefined, color: on ? "var(--color-primary)" : undefined }}
            >
              {lbl}
              {n > 0 && <span className="ws-nav-count">{n > 99 ? "99+" : n}</span>}
            </button>
          );
        })}
      </div>

      {items === null ? (
        <div className="ws-empty-hint" style={{ marginTop: 24 }}>불러오는 중…</div>
      ) : items.length === 0 ? (
        <div className="ws-empty-hint" style={{ marginTop: 24 }}>{type === "all" ? "알림이 없습니다. 배정·멘션·승인·마감·제안·공유 알림이 여기에 쌓입니다." : "이 종류의 알림이 없습니다."}</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 18 }}>
          {grouped && groups.map((g) => {
            const list = g.ids.map((id) => byId.get(id)).filter((x): x is Notif => !!x);
            // ids 는 최신순 — 가장 오래된 id 로 키를 잡아야 30초 갱신 때 새 알림이 묶음에 합류해도
            // 키가 바뀌지 않아 펼침 상태가 유지된다(React 키·펼침 Set 같은 키).
            const gk = g.key + g.ids[g.ids.length - 1];
            if (list.length === 1) return <Row key={gk} n={list[0]} onOpen={open} />;
            const expanded = open_.has(gk);
            return (
              <div key={gk} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                  <button
                    onClick={() => setOpen((p) => { const nx = new Set(p); if (nx.has(gk)) nx.delete(gk); else nx.add(gk); return nx; })}
                    aria-expanded={expanded}
                    style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderRadius: 10, flex: 1, minWidth: 0,
                      border: `1px solid ${g.unread ? "var(--color-primary)" : "var(--border-subtle)"}`, background: "var(--surface-card)",
                      cursor: "pointer", textAlign: "left", opacity: g.unread ? 1 : 0.65, font: "inherit", color: "inherit" }}
                  >
                    <span style={{ display: "flex", color: "var(--color-primary)" }}><Icon name={TYPE_ICON[g.type] ?? "bell"} /></span>
                    <span className="ws-nav-count">{g.count}</span>
                    <span className="ws-btn-soft" style={{ padding: "1px 8px", fontSize: 11.5 }}>{TYPE_LABEL[g.type] ?? g.type}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: g.unread ? 700 : 500, color: "var(--text-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {g.sample[0]} <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>· {g.count - 1}건 더</span>
                    </span>
                  </button>
                  {g.unread > 0 && (
                    <button className="ws-btn-soft" onClick={() => void readGroup(g.ids)} disabled={busy}>이 묶음 읽음</button>
                  )}
                </div>
                {expanded && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 24 }}>
                    {list.map((n) => <Row key={n.id} n={n} onOpen={open} />)}
                  </div>
                )}
              </div>
            );
          })}
          {!grouped && items.map((n) => <Row key={n.id} n={n} onOpen={open} />)}
        </div>
      )}
    </div>
  );
}

function Row({ n, onOpen }: { n: Notif; onOpen: (n: Notif) => void | Promise<void> }) {
  return (
    <button
      onClick={() => void onOpen(n)}
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
  );
}

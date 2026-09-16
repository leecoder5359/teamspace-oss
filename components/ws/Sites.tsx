"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";

/* =====================================================================
   퍼블리시 — HTML/zip 을 올려 초대 이메일로만 열리는 링크를 만든다(/api/sites).
   게스트 알림은 자동 발송하지 않는다(메일 인프라 없음) → 복사 문구를 보여준다.
   ===================================================================== */

type SiteItem = {
  id: string; slug: string; title: string; status: "active" | "disabled";
  currentVersion: number; inviteCount: number; lastAccessAt: string | null; url: string;
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ko-KR") : "아직 없음");

export default function Sites() {
  const router = useRouter();
  const [list, setList] = useState<SiteItem[] | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [invites, setInvites] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 목록에서 바로 초대 — 상세로 들어가야 초대할 수 있다는 걸 알아채기 어려웠다.
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [inviteText, setInviteText] = useState("");
  const [inviteMsg, setInviteMsg] = useState<{ share?: string; error?: string } | null>(null);

  async function load() {
    const res = await fetch("/api/sites", { cache: "no-store" });
    const data = (await res.json()) as { sites: SiteItem[] };
    setList(data.sites);
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  async function create() {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const form = new FormData();
      form.set("file", file);
      if (title.trim()) form.set("title", title.trim());
      if (invites.trim()) form.set("invites", invites);
      const res = await fetch("/api/sites", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) return setErr(data.error ?? "퍼블리시 실패");
      router.push(`/sites/${data.site.id}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleInvite(id: string) {
    setInvitingId((cur) => (cur === id ? null : id));
    setInviteText("");
    setInviteMsg(null);
  }

  async function invite(site: SiteItem) {
    const emails = inviteText.split(/[\s,;]+/).filter(Boolean);
    if (!emails.length) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${site.id}/invites`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emails }),
      });
      const data = (await res.json()) as { added?: string[]; invalid?: string[]; error?: string };
      if (!res.ok) return setInviteMsg({ error: data.error ?? "초대 실패" });
      setInviteText("");
      setInviteMsg({
        share: data.added?.length ? `이 링크를 열고 ${data.added.join(", ")} 계정으로 Google 로그인하세요: ${site.url}` : undefined,
        error: data.invalid?.length ? `형식이 틀린 이메일: ${data.invalid.join(", ")}` : undefined,
      });
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (list === null) return <div className="ws-db" style={{ padding: 40 }} />;

  return (
    <div className="ws-db" style={{ maxWidth: 820 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="link" /> 퍼블리시
      </h1>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
        HTML 파일이나 zip(index.html 포함)을 올리면 초대한 이메일로 Google 로그인한 사람만 볼 수 있는 링크가 생깁니다.
      </p>

      <div style={card}>
        <input type="file" accept=".html,.htm,.zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={inputStyle} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목(비우면 파일 이름)" style={{ ...inputStyle, marginTop: 8 }} />
        <textarea value={invites} onChange={(e) => setInvites(e.target.value)} placeholder="초대할 이메일 (쉼표·줄바꿈으로 여러 개)" rows={2} style={{ ...inputStyle, marginTop: 8, resize: "vertical" }} />
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={create} disabled={busy || !file} style={primaryBtn}>
            <Icon name="plus" /> 퍼블리시
          </button>
        </div>
        {err && <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 8 }}>{err}</div>}
      </div>

      {list.length === 0 ? (
        <div className="ws-empty">
          <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-body)" }}>퍼블리시한 페이지가 없어요</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 5 }}>위에서 파일을 올려 보세요. Claude 세션에서는 `pnpm ws site publish` 로 올릴 수 있어요.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((s) => (
            <div key={s.id} style={{ ...row, flexDirection: "column", alignItems: "stretch" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <Link href={`/sites/${s.id}`} style={{ fontSize: 13.5, color: "var(--text-strong)", fontWeight: 600 }}>{s.title}</Link>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                    v{s.currentVersion} · 초대 {s.inviteCount}명 · 마지막 열람 {fmt(s.lastAccessAt)}
                    {s.status === "disabled" ? " · 비활성" : ""}
                  </div>
                </div>
                <button className="ws-btn-soft" onClick={() => toggleInvite(s.id)} aria-expanded={invitingId === s.id}>
                  <Icon name="users" /> 이메일 초대
                </button>
                <Link className="ws-btn-soft" href={`/sites/${s.id}`}>관리</Link>
                <button className="ws-btn-soft" onClick={() => navigator.clipboard.writeText(s.url)} title="링크 복사">
                  <Icon name="link" />
                </button>
              </div>
              {invitingId === s.id && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <input
                      autoFocus
                      value={inviteText}
                      onChange={(e) => setInviteText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") void invite(s); }}
                      placeholder="guest@gmail.com, 쉼표로 여러 명"
                      style={{ ...inputStyle, flex: 1, minWidth: 200 }}
                    />
                    <button onClick={() => invite(s)} disabled={busy || !inviteText.trim()} style={primaryBtn}>
                      <Icon name="plus" /> 초대
                    </button>
                  </div>
                  {inviteMsg?.error && <div style={{ fontSize: 12.5, color: "#c0392b", marginTop: 8 }}>{inviteMsg.error}</div>}
                  {inviteMsg?.share && (
                    <div style={{ marginTop: 8, fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start" }}>
                      <span style={{ flex: 1, wordBreak: "break-all" }}>{inviteMsg.share}</span>
                      <button className="ws-btn-soft" onClick={() => navigator.clipboard.writeText(inviteMsg.share!)}>문구 복사</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const card: CSSProperties = { border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, margin: "16px 0" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", flexWrap: "wrap" };
export const inputStyle: CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 16, fontFamily: "inherit" };
export const primaryBtn: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff", display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" };

"use client";

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { inputStyle, primaryBtn } from "./Sites";

type Detail = {
  site: { id: string; slug: string; title: string; status: "active" | "disabled"; currentVersion: number };
  url: string;
  versions: { version: number; fileCount: number; sizeBytes: number; createdAt: string }[];
  invites: { email: string; createdAt: string; lastAccessAt: string | null }[];
};

type AccountAccess = {
  email: string;
  kind: "invited" | "member" | "revoked";
  count: number;
  firstAt: string;
  lastAt: string;
  recent: { at: string; version: number }[];
};

const KIND_LABEL: Record<AccountAccess["kind"], string> = { invited: "초대", member: "멤버", revoked: "초대 회수됨" };
const when = (iso: string) => new Date(iso).toLocaleString("ko-KR");

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.ceil(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`);

export default function SiteDetail({ id }: { id: string }) {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [emails, setEmails] = useState("");
  const [share, setShare] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [access, setAccess] = useState<{ accounts: AccountAccess[]; windowDays: number } | null>(null);
  const [openEmail, setOpenEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [res, acc] = await Promise.all([
      fetch(`/api/sites/${id}`, { cache: "no-store" }),
      fetch(`/api/sites/${id}/access`, { cache: "no-store" }),
    ]);
    if (res.status === 404) return router.replace("/sites");
    setD(await res.json());
    if (acc.ok) setAccess(await acc.json());
  }, [id, router]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(fn: () => Promise<Response>) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fn();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(data.error ?? "실패");
      else if (data.warnings?.length) setMsg(data.warnings.join("\n"));
      await load();
      return res.ok ? data : null;
    } finally {
      setBusy(false);
    }
  }

  const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  async function invite() {
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    if (!list.length) return;
    const data = await run(() => fetch(`/api/sites/${id}/invites`, json("POST", { emails: list })));
    if (data && d) {
      setEmails("");
      if (data.invalid?.length) setMsg(`형식이 틀린 이메일: ${data.invalid.join(", ")}`);
      if (data.added?.length) setShare(`이 링크를 열고 ${data.added.join(", ")} 계정으로 Google 로그인하세요: ${d.url}`);
    }
  }

  async function upload(file: File) {
    const form = new FormData();
    form.set("file", file);
    await run(() => fetch(`/api/sites/${id}/versions`, { method: "POST", body: form }));
  }

  if (!d) return <div className="ws-db" style={{ padding: 40 }} />;
  const { site } = d;

  return (
    <div className="ws-db" style={{ maxWidth: 820 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Icon name="link" /> {site.title}
        {site.status === "disabled" && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>· 비활성</span>}
      </h1>

      <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <code style={{ flex: 1, minWidth: 0, fontSize: 12.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.url}</code>
        <button className="ws-btn-soft" onClick={() => navigator.clipboard.writeText(d.url)}>링크 복사</button>
        <a className="ws-btn-soft" href={d.url} target="_blank" rel="noreferrer">미리보기</a>
      </div>
      {msg && <pre style={{ whiteSpace: "pre-wrap", fontSize: 12.5, color: "#c0392b" }}>{msg}</pre>}

      <h2 style={h2}>초대</h2>
      <div style={card}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="guest@gmail.com, ..." style={{ ...inputStyle, flex: 1, minWidth: 200 }} />
          <button onClick={invite} disabled={busy || !emails.trim()} style={primaryBtn}><Icon name="plus" /> 초대</button>
        </div>
        {share && (
          <div style={{ marginTop: 10, fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start" }}>
            <span style={{ flex: 1 }}>{share}</span>
            <button className="ws-btn-soft" onClick={() => navigator.clipboard.writeText(share)}>문구 복사</button>
          </div>
        )}
        {d.invites.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 10 }}>아직 초대한 사람이 없어요. 초대 전에는 워크스페이스 멤버만 볼 수 있어요.</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
            {d.invites.map((i) => (
              <li key={i.email} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{i.email}</span>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{i.lastAccessAt ? `열어봄 ${new Date(i.lastAccessAt).toLocaleString("ko-KR")}` : "아직"}</span>
                <button className="ws-btn-soft" disabled={busy} title="초대 회수" onClick={() => run(() => fetch(`/api/sites/${id}/invites`, json("DELETE", { emails: [i.email] })))}>
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2 style={h2}>접근 이력</h2>
      <div style={card}>
        {!access || access.accounts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>아직 열어본 사람이 없어요. 링크를 열면 계정별로 여기 쌓입니다(같은 계정이 10분 안에 다시 열면 한 번으로 셉니다).</div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {access.accounts.map((a) => (
              <li key={a.email} style={{ borderTop: "1px solid var(--border-subtle)", padding: "8px 0" }}>
                <button
                  onClick={() => setOpenEmail((cur) => (cur === a.email ? null : a.email))}
                  aria-expanded={openEmail === a.email}
                  style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left", flexWrap: "wrap", color: "inherit", font: "inherit" }}
                >
                  <span style={{ flex: 1, minWidth: 160, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>{a.email}</span>
                  <span style={{ fontSize: 11.5, padding: "1px 7px", borderRadius: 999, background: "var(--surface-sunken)", color: a.kind === "revoked" ? "#c0392b" : "var(--text-muted)" }}>{KIND_LABEL[a.kind]}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {a.count}회 · 처음 {when(a.firstAt)} · 마지막 {when(a.lastAt)}
                  </span>
                </button>
                {openEmail === a.email && (
                  <ul style={{ listStyle: "none", padding: "6px 0 0 12px", margin: 0 }}>
                    {a.recent.map((r) => (
                      <li key={r.at} style={{ fontSize: 12, color: "var(--text-muted)", padding: "2px 0" }}>
                        {when(r.at)} · v{r.version}
                      </li>
                    ))}
                    {a.count > a.recent.length && (
                      <li style={{ fontSize: 12, color: "var(--text-muted)", padding: "2px 0" }}>… 이전 {a.count - a.recent.length}건</li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2 style={h2}>버전</h2>
      <div style={card}>
        <label className="ws-btn-soft" style={{ cursor: "pointer" }}>
          새 파일 올리기(.html/.zip)
          <input type="file" accept=".html,.htm,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        </label>
        <ul style={{ listStyle: "none", padding: 0, margin: "10px 0 0" }}>
          {d.versions.map((v) => (
            <li key={v.version} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13, flexWrap: "wrap" }}>
              <b>v{v.version}</b>
              <span style={{ flex: 1, color: "var(--text-muted)", fontSize: 12 }}>{v.fileCount}개 · {kb(v.sizeBytes)} · {new Date(v.createdAt).toLocaleString("ko-KR")}</span>
              {v.version === site.currentVersion ? (
                <span style={{ fontSize: 12, color: "var(--color-primary)" }}>현재</span>
              ) : (
                <button className="ws-btn-soft" disabled={busy} onClick={() => run(() => fetch(`/api/sites/${id}`, json("PATCH", { currentVersion: v.version })))}>이 버전으로</button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <h2 style={h2}>관리</h2>
      <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="ws-btn-soft" disabled={busy} onClick={() => run(() => fetch(`/api/sites/${id}`, json("PATCH", { status: site.status === "active" ? "disabled" : "active" })))}>
          {site.status === "active" ? "비활성화(링크 차단)" : "다시 활성화"}
        </button>
        <button className="ws-btn-soft" disabled={busy} onClick={async () => {
          if (!window.confirm(`'${site.title}' 을 삭제할까요? 링크가 즉시 막힙니다.`)) return;
          const ok = await run(() => fetch(`/api/sites/${id}`, { method: "DELETE" }));
          if (ok) router.push("/sites");
        }}>
          삭제
        </button>
      </div>
    </div>
  );
}

const card: CSSProperties = { border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, margin: "10px 0 16px" };
const h2: CSSProperties = { fontSize: 14, fontWeight: 700, margin: "18px 0 0", color: "var(--text-strong)" };

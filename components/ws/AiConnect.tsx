"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";

const mono: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: "0.92em", background: "var(--surface-sunken)", padding: "1px 5px", borderRadius: 5 };

/* =====================================================================
   AI 연결 — Claude 세션 탐색기(M4). 인입된 세션 목록 + 세션 상세(아이템 타임라인).
   실시간 인입은 /api/ingest (agentmemory 훅 → 이 엔드포인트).
   ===================================================================== */

type Session = {
  id: string;
  externalId: string;
  project: string | null;
  cwd: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  _count: { items: number };
};

type Item = { id: string; kind: string; body: Record<string, unknown>; externalRef: string | null; createdAt: string };
type Detail = Omit<Session, "_count"> & { items: Item[] };

const KIND: Record<string, { label: string; icon: IconName; color: string }> = {
  observation: { label: "관찰", icon: "circle", color: "#2F62FF" },
  summary: { label: "요약", icon: "doc", color: "#7165E3" },
  decision: { label: "결정", icon: "flag", color: "#12B886" },
  commit: { label: "커밋", icon: "refresh", color: "#F5A623" },
  file_change: { label: "파일변경", icon: "table", color: "#F0494E" },
};

function bodyText(b: Record<string, unknown>): string {
  if (typeof b.text === "string") return b.text;
  if (typeof b.msg === "string") return b.msg;
  if (typeof b.path === "string") return b.path;
  const s = JSON.stringify(b);
  return s === "{}" ? "" : s;
}

type Ctx = { markdown: string; counts: Record<string, number> };

export function LoadErrorNotice({ onRetry, message = "세션 목록을 불러오지 못했어요." }: { onRetry: () => void; message?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 4px", fontSize: 13, color: "var(--text-sub)" }}>
      <span>{message}</span>
      <button className="ws-btn-soft" onClick={onRetry}>다시 시도</button>
    </div>
  );
}

export default function AiConnect() {
  const [list, setList] = useState<Session[] | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // 컨텍스트 실패는 따로 — 실패해도 세션 목록은 보이고, 이 섹션만 안내+다시 시도(스켈레톤이 영원히 돌지 않게).
  const [ctxError, setCtxError] = useState(false);
  const [ctxAttempt, setCtxAttempt] = useState(0);

  // 세션 목록과 컨텍스트는 서로 기다리지 않는다 — 먼저 오는 쪽이 먼저 그려진다.
  useEffect(() => {
    void (async () => {
      try {
        const sRes = await fetch("/api/sessions", { cache: "no-store" });
        if (!sRes.ok) throw new Error(`sessions ${sRes.status}`);
        const data = (await sRes.json()) as { sessions: Session[] };
        setList(data.sessions);
      } catch {
        setLoadError(true);
      }
    })();
  }, [attempt]);
  useEffect(() => {
    void (async () => {
      try {
        const cRes = await fetch("/api/context?format=json", { cache: "no-store" });
        if (!cRes.ok) throw new Error(`context ${cRes.status}`);
        setCtx((await cRes.json()) as Ctx);
      } catch {
        setCtxError(true);
      }
    })();
  }, [ctxAttempt]);

  async function copyContext() {
    if (!ctx) return;
    try {
      await navigator.clipboard.writeText(ctx.markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard 미지원 환경 무시 */
    }
  }
  function downloadContext() {
    if (!ctx) return;
    const blob = new Blob([ctx.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "teamspace-context.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function open(id: string) {
    setLoadingDetail(true);
    setDetail(null);
    try {
      const res = await fetch(`/api/sessions/${id}`, { cache: "no-store" });
      const data = (await res.json()) as { session: Detail };
      setDetail(data.session);
    } finally {
      setLoadingDetail(false);
    }
  }

  // ── 상세 ──
  if (list !== null && (detail || loadingDetail)) {
    return (
      <div className="ws-db" style={{ maxWidth: 820 }}>
        <button className="ws-btn-soft" onClick={() => setDetail(null)} style={{ marginBottom: 16 }}>
          <Icon name="chevronLeft" size={15} /> 세션 목록
        </button>
        {loadingDetail || !detail ? (
          <div className="ws-empty-hint">불러오는 중…</div>
        ) : (
          <>
            <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Icon name="logo" /> {detail.project ?? detail.cwd ?? detail.externalId}
            </h1>
            <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
              {detail.cwd ?? "—"} · {new Date(detail.startedAt).toLocaleString("ko-KR")} · {detail.status}
            </div>

            <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 2 }}>
              {detail.items.length === 0 ? (
                <div className="ws-empty-hint">아이템이 없습니다.</div>
              ) : (
                detail.items.map((it) => {
                  const k = KIND[it.kind] ?? { label: it.kind, icon: "circle" as IconName, color: "#9AA0A6" };
                  return (
                    <div key={it.id} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-subtle)" }}>
                      <span style={{ display: "flex", color: k.color, marginTop: 1, flex: "0 0 auto" }}>
                        <Icon name={k.icon} size={16} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 11.5, fontWeight: 700, color: k.color }}>{k.label}</span>
                          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{new Date(it.createdAt).toLocaleTimeString("ko-KR")}</span>
                          {it.externalRef && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>{it.externalRef}</span>}
                        </div>
                        <div style={{ fontSize: 13, color: "var(--text-body)", marginTop: 3, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {bodyText(it.body) || "—"}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  // ── 목록 (Claude가 워크스페이스를 읽는 화면) ──
  const apiBase = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="ws-db" style={{ maxWidth: 880 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="logo" /> AI 연결
      </h1>
      <p style={{ fontSize: 12.5, color: "var(--text-sub)", marginTop: 4, lineHeight: 1.6 }}>
        Claude 세션이 teamspace 스킬과 <code style={mono}>/api/*</code> 로 이 워크스페이스의 문서·보드·결정을 직접 읽어요. 아래는 Claude가 읽는 컨텍스트 스냅샷이에요.
      </p>

      {/* 공유 컨텍스트 (Claude가 읽는 내용) */}
      <section style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16, marginTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)" }}>공유 컨텍스트</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Claude가 읽는 내용</span>
          <span style={{ flex: 1 }} />
          <button className="ws-btn-soft" onClick={() => void copyContext()} disabled={!ctx}>
            <Icon name="doc" size={13} /> {copied ? "복사됨" : "복사"}
          </button>
          <button className="ws-btn-soft" onClick={downloadContext} disabled={!ctx}>
            <Icon name="arrowRight" size={13} /> .md 내보내기
          </button>
        </div>
        {!ctx && ctxError ? (
          <LoadErrorNotice message="컨텍스트를 불러오지 못했어요." onRetry={() => { setCtxError(false); setCtxAttempt((n) => n + 1); }} />
        ) : !ctx ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-busy="true">
            <div className="ws-skeleton" style={{ height: 24, width: "60%", borderRadius: 999 }} />
            <div className="ws-skeleton" style={{ height: 140, borderRadius: 10, border: "1px solid var(--border-subtle)" }} />
            <div className="ws-skeleton" style={{ height: 140, borderRadius: 10, border: "1px solid var(--border-subtle)" }} />
          </div>
        ) : (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
              {([["태스크", ctx.counts.tasks], ["문서", ctx.counts.docs], ["결정", ctx.counts.decisions], ["리스크", ctx.counts.risks], ["용어", ctx.counts.glossary]] as [string, number][]).map(([l, n]) => (
                <span key={l} style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-sub)", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "2px 10px" }}>{l} {n}</span>
              ))}
            </div>
            <pre style={{ margin: 0, padding: 14, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, color: "var(--text-body)", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: 10, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 280, overflow: "auto" }}>{ctx.markdown}</pre>
          </>
        )}
      </section>

      {/* 연결 방법 */}
      <section style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16, marginTop: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text-strong)", marginBottom: 10 }}>연결 방법</div>
        <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 7, fontSize: 12.5, color: "var(--text-sub)", lineHeight: 1.6 }}>
          <li>스킬: <code style={mono}>.claude/skills/teamspace/SKILL.md</code> — 이 레포에서 Claude가 자동 로드, 보드·문서·결정을 API로 다루는 법을 안내.</li>
          <li>CLI: <code style={mono}>pnpm ws &lt;명령&gt;</code> — 예: <code style={mono}>ws doc cat &lt;id&gt;</code>, <code style={mono}>ws decision ls</code>, <code style={mono}>ws search &lt;q&gt;</code>.</li>
          <li>읽기 API: <code style={mono}>GET {apiBase}/api/context</code>(이 스냅샷) · <code style={mono}>/api/pages</code> · <code style={mono}>/api/pages/&lt;id&gt;</code> · <code style={mono}>/api/search?q=</code>.</li>
          <li>문서는 file-first: <code style={mono}>docs/*.md</code>(git) — 세션이 파일을 직접 읽을 수도 있어요.</li>
        </ul>
      </section>

      <h2 style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", margin: "28px 0 4px" }}>Claude 작업 세션</h2>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>cwd→워크스페이스로 매핑된 세션. 실시간 인입은 agentmemory 훅 → <code style={mono}>/api/ingest</code>.</p>

      {list === null && loadError ? (
        <LoadErrorNotice onRetry={() => { setLoadError(false); setAttempt((n) => n + 1); }} />
      ) : list === null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }} aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="ws-skeleton" style={{ height: 63, borderRadius: 10, border: "1px solid var(--border-subtle)" }} />
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="ws-empty" style={{ marginTop: 24 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: "var(--surface-sunken)", color: "var(--text-disabled)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px" }}>
            <Icon name="logo" />
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--text-body)" }}>아직 인입된 세션이 없어요</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 5 }}>
            agentmemory 훅을 /api/ingest 로 연결하면 관찰·요약·결정·커밋이 여기에 모여요.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16 }}>
          {list.map((s) => (
            <button
              key={s.id}
              onClick={() => open(s.id)}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", cursor: "pointer", textAlign: "left", font: "inherit" }}
            >
              <span style={{ display: "flex", color: s.status === "active" ? "var(--color-success)" : "var(--text-disabled)" }}>
                <Icon name="circle" />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: "var(--text-strong)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.project ?? s.cwd ?? s.externalId}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  {new Date(s.startedAt).toLocaleString("ko-KR")} · {s._count.items}개 항목 · {s.status}
                </div>
              </div>
              <Icon name="chevronRight" size={16} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

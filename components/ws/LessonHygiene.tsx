"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { IdChip, ghostBtn } from "./ui";
import { Pill, Table, Sub, td, rowStyle, hint, empty } from "./AiRoutes";

/* =====================================================================
   설정 › 레슨 주간 정리 — GET /api/lessons/hygiene · /api/lessons/hygiene/<id>.
   워커가 매주 월요일 만든 정리 제안(병합·삭제·범위·필수·키워드·검토)을 전부 보여 준다.
   슬랙 승인 카드의 '전체 보기' 링크가 /settings#lesson-hygiene 로 여기에 온다.
   관리자: 저장 없이 미리 보기, 적용된 정리 되돌리기. 표·알약은 기존 설정 화면 패턴 그대로.
   ===================================================================== */

type Proposal = {
  merges: { keepId: string; mergeIds: string[]; newTitle: string; newBody: string; reason: string }[];
  drops: { id: string; reason: string }[];
  review: { id: string; reason: string }[];
  required: { id: string; to: "required" | "default"; reason: string }[];
  ondemand: { id: string; keywords: string[]; reason: string }[];
  scopeFixes: { id: string; to: string; reason: string }[];
};
type RunRow = { id: string; weekKey: string; status: string; summary: string; counts: Record<keyof Proposal, number>; appliedAt: string | null; revertedAt: string | null; createdAt: string };
type Detail = { run: { id: string; weekKey: string; status: string; summary: string; proposal: Proposal; hasBackup: boolean }; titles: Record<string, string> };

const STATUS: Record<string, { label: string; color: string }> = {
  proposed: { label: "승인 대기", color: "#F5A623" },
  applied: { label: "적용됨", color: "#12B886" },
  rejected: { label: "거부됨", color: "#9AA0A6" },
  empty: { label: "정리할 것 없음", color: "#9AA0A6" },
  failed: { label: "적용 실패", color: "#C0392B" },
  reverted: { label: "되돌림", color: "#9AA0A6" },
};
const when = (iso: string) => new Date(iso).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export default function LessonHygiene({ isAdmin }: { isAdmin: boolean }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [preview, setPreview] = useState<{ summary: string; proposal: Proposal } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await fetch("/api/lessons/hygiene?limit=12", { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as { runs?: RunRow[]; enabled?: boolean; error?: string };
      if (!alive) return;
      if (!res.ok) return void setError(d.error ?? "불러오지 못했습니다.");
      setRuns(d.runs ?? []);
      setEnabled(d.enabled !== false);
      setSel((cur) => cur ?? d.runs?.[0]?.id ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!sel) return;
    let alive = true;
    void (async () => {
      const res = await fetch(`/api/lessons/hygiene/${sel}`, { cache: "no-store" });
      const d = (await res.json().catch(() => ({}))) as Detail & { error?: string };
      if (!alive) return;
      if (!res.ok) return void setError(d.error ?? "불러오지 못했습니다.");
      setDetail(d);
    })();
    return () => {
      alive = false;
    };
  }, [sel, reload]);

  async function dryRun() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/lessons/hygiene", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dryRun: true }) });
      const d = (await res.json().catch(() => ({}))) as { summary?: string; proposal?: Proposal; error?: string };
      if (!res.ok || !d.proposal) return void setError(d.error ?? "미리 보기에 실패했습니다.");
      setPreview({ summary: d.summary ?? "", proposal: d.proposal });
    } finally {
      setBusy(false);
    }
  }

  async function revert(id: string) {
    if (!window.confirm("이 정리를 되돌릴까요? 지운 레슨은 원래 id 로 다시 만들고, 바꾼 레슨은 적용 전 값으로 돌아갑니다(그 뒤 고친 내용도 덮입니다).")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lessons/hygiene/${id}/revert`, { method: "POST" });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return void setError(d.error ?? "되돌리지 못했습니다.");
      setReload((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p style={{ ...hint, marginTop: 0, marginBottom: 12 }}>
        매주 월요일 오전 워커가 주입·조회가 없는 레슨, 키워드 없는 &lsquo;필요할 때만&rsquo; 레슨, 제목이 비슷한 레슨, 너무 많은 필수 레슨을 찾아 정리안을 만들고 슬랙 승인 카드로 보냅니다. 승인하면 적용되고(적용 전 백업),
        되돌릴 수 있습니다. 개인 레슨은 건드리지 않습니다. CLI: <code>pnpm ws lesson hygiene</code>
        {!enabled && " · 지금 워커 주간 정리는 꺼져 있습니다(LESSON_HYGIENE=off)."}
      </p>
      {isAdmin && (
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button type="button" onClick={() => void dryRun()} disabled={busy} style={ghostBtn}>
            {busy ? "계산 중…" : "지금 미리 보기(저장 안 함)"}
          </button>
        </div>
      )}
      {error && <p style={{ ...hint, color: "var(--text-body)" }}>{error}</p>}

      {preview && (
        <Sub label="미리 보기 — 저장·카드 없음">
          <pre style={pre}>{preview.summary}</pre>
          <ProposalTables p={preview.proposal} titles={{}} />
        </Sub>
      )}

      <Sub label="실행 기록">
        {!runs && <p style={empty}>불러오는 중…</p>}
        {runs && runs.length === 0 && <p style={empty}>아직 실행이 없습니다.</p>}
        {runs && runs.length > 0 && (
          <Table head={["주", "상태", "병합·삭제·범위·필수·키워드·검토", "만든 시각"]} numericFrom={4}>
            {runs.map((r) => {
              const st = STATUS[r.status] ?? { label: r.status, color: "#9AA0A6" };
              const c = r.counts;
              return (
                <tr key={r.id} style={{ ...rowStyle, cursor: "pointer", background: sel === r.id ? "color-mix(in srgb, var(--color-primary) 6%, transparent)" : undefined }} onClick={() => setSel(r.id)}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); setSel(r.id); } }}>
                  <td style={{ ...td, fontWeight: 600, color: "var(--text-strong)", whiteSpace: "nowrap" }}>{r.weekKey}</td>
                  <td style={td}>
                    <Pill color={st.color} label={st.label} />
                  </td>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                    {c.merges} · {c.drops} · {c.scopeFixes} · {c.required} · {c.ondemand} · {c.review}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{when(r.createdAt)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Sub>

      {detail && (
        <Sub label={`${detail.run.weekKey} 전체 제안`}>
          <pre style={pre}>{detail.run.summary}</pre>
          {isAdmin && detail.run.status === "applied" && detail.run.hasBackup && (
            <button type="button" onClick={() => void revert(detail.run.id)} disabled={busy} style={{ ...ghostBtn, color: "#C0392B", marginBottom: 10 }}>
              되돌리기
            </button>
          )}
          <ProposalTables p={detail.run.proposal} titles={detail.titles} />
        </Sub>
      )}
    </div>
  );
}

function ProposalTables({ p, titles }: { p: Proposal; titles: Record<string, string> }) {
  const T = (id: string) => (
    <span>
      {titles[id] ? `${titles[id]} ` : ""}
      <IdChip id={id} />
    </span>
  );
  const any = p.merges.length + p.drops.length + p.scopeFixes.length + p.required.length + p.ondemand.length + p.review.length > 0;
  if (!any) return <p style={empty}>정리할 항목이 없습니다.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {p.merges.length > 0 && (
        <Table head={["병합 — 남길 레슨", "흡수(삭제)", "새 제목 · 이유"]} numericFrom={3}>
          {p.merges.map((m) => (
            <tr key={m.keepId} style={rowStyle}>
              <td style={td}>
                {T(m.keepId)}
              </td>
              <td style={td}>
                {m.mergeIds.map((id) => (
                  <div key={id}>{T(id)}</div>
                ))}
              </td>
              <td style={td}>
                <div style={{ fontWeight: 600, color: "var(--text-strong)" }}>{m.newTitle}</div>
                {m.reason && <div style={{ ...hint, marginTop: 2 }}>{m.reason}</div>}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {p.drops.length > 0 && <SimpleTable head="삭제" rows={p.drops.map((d) => ({ id: d.id, note: d.reason }))} T={T} />}
      {p.scopeFixes.length > 0 && <SimpleTable head="범위 변경" rows={p.scopeFixes.map((s) => ({ id: s.id, note: `→ ${s.to}${s.reason ? ` — ${s.reason}` : ""}` }))} T={T} />}
      {p.required.length > 0 && <SimpleTable head="필수 변경" rows={p.required.map((r) => ({ id: r.id, note: `${r.to === "required" ? "필수로" : "기본으로"}${r.reason ? ` — ${r.reason}` : ""}` }))} T={T} />}
      {p.ondemand.length > 0 && <SimpleTable head="키워드 채움" rows={p.ondemand.map((o) => ({ id: o.id, note: o.keywords.join(", ") }))} T={T} />}
      {p.review.length > 0 && <SimpleTable head="검토(적용 안 함)" rows={p.review.map((r) => ({ id: r.id, note: r.reason }))} T={T} />}
    </div>
  );
}

function SimpleTable({ head, rows, T }: { head: string; rows: { id: string; note: string }[]; T: (id: string) => React.ReactNode }) {
  return (
    <Table head={[head, "내용"]} numericFrom={2}>
      {rows.map((r) => (
        <tr key={r.id} style={rowStyle}>
          <td style={td}>{T(r.id)}</td>
          <td style={td}>{r.note}</td>
        </tr>
      ))}
    </Table>
  );
}

const pre: CSSProperties = { ...hint, marginTop: 0, marginBottom: 10, whiteSpace: "pre-wrap", fontFamily: "inherit" };

"use client";

import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/* =====================================================================
   "문서에서 추출 (AI)" 패널 — 문서 선택 → 추출 → 제안 검토 → 개별 반영.

   용어집(GlossarySurface)·데이터모델(DataModelSurface)이 각자 손으로 들고 있던
   패널을 DoD·온보딩·QA 로 넓히면서 공통 껍데기만 여기로 뺐다. 도메인마다 다른 것은
   제안 본문 렌더링과 수락 요청뿐이라 그 둘만 props 로 받는다.
   (기존 두 화면은 각자 구현을 그대로 쓴다 — 나중에 여기로 옮길 수 있다.)

   자동 기록하지 않는다: 추출은 제안까지고, 반영은 사람이 항목별로 누른다.
   ===================================================================== */

export type ProposalStatus = "new" | "duplicate" | "conflict";

const STATUS_BADGE: Record<ProposalStatus, { label: string; color: string }> = {
  new: { label: "신규", color: "var(--color-primary)" },
  conflict: { label: "모순", color: "#E0900F" },
  duplicate: { label: "중복", color: "var(--text-disabled)" },
};

type Page = { id: string; title: string; kind: string };

export default function ExtractPanel<P extends { status: ProposalStatus }>({
  label,
  endpoint,
  extraBody,
  runningText,
  emptyText,
  keyOf,
  renderProposal,
  onAccept,
  onAccepted,
}: {
  /** 패널 제목. 예: "문서에서 완료 기준 추출 (AI)" */
  label: string;
  /** 추출 라우트. 예: "/api/dod/extract" */
  endpoint: string;
  /** pageId 외에 함께 보낼 값(예: QA 의 projectId) */
  extraBody?: Record<string, unknown>;
  runningText: string;
  emptyText: string;
  /** 제안 식별자 — 반영 완료 표시에 쓴다 */
  keyOf: (p: P) => string;
  renderProposal: (p: P) => ReactNode;
  /** 수락 요청. 응답을 그대로 돌려주면 실패를 패널이 표시한다. */
  onAccept: (p: P, sourcePageId: string) => Promise<Response>;
  /** 수락 성공 후 목록 갱신 */
  onAccepted: () => Promise<void> | void;
}) {
  const [pages, setPages] = useState<Page[]>([]);
  const [pageId, setPageId] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [proposals, setProposals] = useState<P[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/pages", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { pages: Page[] };
      setPages(d.pages.filter((p) => p.kind !== "database"));
    })();
  }, []);

  async function run() {
    if (!pageId || extracting) return;
    setExtracting(true);
    setProposals(null);
    setErr(null);
    setAccepted(new Set());
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pageId, ...extraBody }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string; proposals?: P[] };
      if (!res.ok || !d.ok) setErr(d.error ?? "추출에 실패했습니다.");
      else setProposals(d.proposals ?? []);
    } catch {
      setErr("추출 중 오류가 발생했습니다.");
    } finally {
      setExtracting(false);
    }
  }

  async function accept(p: P) {
    const res = await onAccept(p, pageId);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(d.error ?? "반영하지 못했습니다.");
      return;
    }
    setErr(null);
    setAccepted((prev) => new Set(prev).add(keyOf(p)));
    await onAccepted();
  }

  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 14, marginBottom: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 8 }}>{label}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <select value={pageId} onChange={(e) => setPageId(e.target.value)} aria-label="추출할 문서" style={{ ...inp, flex: 1, cursor: "pointer" }}>
          <option value="">문서 선택…</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>{p.title || "제목 없음"}</option>
          ))}
        </select>
        <button style={primary} disabled={!pageId || extracting} onClick={run}>
          {extracting ? "추출 중…" : "추출"}
        </button>
      </div>
      {extracting && <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>{runningText}</p>}
      {err && <p style={{ fontSize: 12.5, color: "#D14343", marginTop: 8 }}>{err}</p>}

      {proposals && proposals.length === 0 && !extracting && (
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 10 }}>{emptyText}</p>
      )}
      {proposals && proposals.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
          {proposals.map((p, i) => {
            const badge = STATUS_BADGE[p.status];
            const done = accepted.has(keyOf(p));
            return (
              <div key={`${keyOf(p)}-${i}`} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", border: "1px solid var(--border-subtle)", borderRadius: 9 }}>
                <span style={{ flex: "0 0 auto", fontSize: 10.5, fontWeight: 700, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 999, padding: "1px 7px", marginTop: 2 }}>{badge.label}</span>
                <div style={{ flex: 1, minWidth: 0 }}>{renderProposal(p)}</div>
                {p.status === "duplicate" ? (
                  <span style={{ flex: "0 0 auto", fontSize: 12, color: "var(--text-disabled)", alignSelf: "center" }}>있음</span>
                ) : done ? (
                  <span style={{ flex: "0 0 auto", fontSize: 12, color: "var(--color-primary)", fontWeight: 600, alignSelf: "center" }}>반영됨</span>
                ) : (
                  // 모순 제안은 기존 항목을 고쳐 쓴다(중복 항목이 쌓이지 않도록) — 버튼 문구도 그렇게 읽혀야 한다.
                  <button className="ws-btn-soft" style={{ flex: "0 0 auto", alignSelf: "center" }} onClick={() => accept(p)}>
                    {p.status === "conflict" ? "갱신" : "추가"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const inp: CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit" };
const primary: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff", whiteSpace: "nowrap" };

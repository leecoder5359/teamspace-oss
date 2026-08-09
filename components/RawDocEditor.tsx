"use client";

import { useEffect, useRef, useState } from "react";
import MarkdownPreview from "./MarkdownPreview";
import { merge3, hasConflictMarkers } from "@/lib/merge3";
import { Icon } from "./ws/icons";

type SaveState = "idle" | "loading" | "saving" | "saved" | "error" | "conflict";
type EditorMode = "edit" | "preview";
type ProvTag = "추출" | "추론" | "모호";
type Claim = { claim: string; tag: ProvTag; note: string };

const TAG_COLOR: Record<ProvTag, string> = { 추출: "var(--color-primary)", 추론: "#E0900F", 모호: "var(--text-disabled)" };
const TAG_HINT: Record<ProvTag, string> = { 추출: "문서에 명시됨", 추론: "유추됨", 모호: "근거 약함" };

export default function RawDocEditor({ pageId }: { pageId: string }) {
  const [markdown, setMarkdown] = useState("");
  const [title, setTitle] = useState("");
  const [state, setState] = useState<SaveState>("loading");
  const [mode, setMode] = useState<EditorMode>("preview");
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const titleRef = useRef(""); // 디바운스 저장 시 stale closure 방지
  const markdownRef = useRef(""); // 디바운스 저장 시 stale closure 방지
  const revRef = useRef(0); // 낙관적 잠금(baseRev) — 서버 rev 추적
  const baseMarkdownRef = useRef(""); // 열었을 때의 본문 — 3-way 병합 base(격차 D1)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 신뢰도 분석(provenance)
  const [provOpen, setProvOpen] = useState(false);
  const [provLoading, setProvLoading] = useState(false);
  const [provClaims, setProvClaims] = useState<Claim[] | null>(null);
  const [provCounts, setProvCounts] = useState<Record<ProvTag, number> | null>(null);
  const [provErr, setProvErr] = useState<string | null>(null);

  async function runProvenance() {
    const next = !provOpen;
    setProvOpen(next);
    if (next && provClaims === null && !provLoading) {
      setProvLoading(true);
      setProvErr(null);
      try {
        const r = await fetch("/api/provenance", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pageId }),
        });
        const d = (await r.json()) as { ok?: boolean; error?: string; claims?: Claim[]; counts?: Record<ProvTag, number> };
        if (!r.ok || !d.ok) setProvErr(d.error ?? "분석에 실패했습니다.");
        else {
          setProvClaims(d.claims ?? []);
          setProvCounts(d.counts ?? null);
        }
      } catch {
        setProvErr("분석 중 오류가 발생했습니다.");
      } finally {
        setProvLoading(false);
      }
    }
  }

  // 페이지 로드: key 리마운트로 pageId당 1회 실행 (setState("loading")은 초기값으로 처리)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/pages/${pageId}`, { cache: "no-store" });
      if (!res.ok || cancelled) return;
      const data = (await res.json()) as { page: { title: string; rev?: number }; markdown: string };
      if (cancelled) return;
      revRef.current = data.page.rev ?? 0;
      const md = data.markdown ?? "";
      setMarkdown(md);
      markdownRef.current = md;
      baseMarkdownRef.current = md;
      setTitle(data.page.title);
      titleRef.current = data.page.title;
      loadedRef.current = true;
      // 미리보기가 기본. 단, 빈 문서(새 문서)는 바로 쓸 수 있게 편집으로 연다.
      setMode(md.trim() ? "preview" : "edit");
      setState("idle");
    })();
    return () => {
      cancelled = true;
    };
  }, [pageId]); // pageId가 바뀔 때만 재로드

  const save = async () => {
    if (!loadedRef.current) return;
    // 충돌 마커가 남은 채로 저장하면 본문이 오염된다 — 정리 전엔 막는다
    if (hasConflictMarkers(markdownRef.current)) {
      setState("conflict");
      setConflictNote("아직 <<<<<<< 충돌 마커가 남아 있습니다. 정리한 뒤 저장하세요.");
      return;
    }
    setState("saving");
    try {
      const res = await fetch(`/api/pages/${pageId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markdown: markdownRef.current, title: titleRef.current, baseRev: revRef.current }),
      });
      if (res.status === 409) {
        // 원문 모드도 같은 계약 — 새로고침을 강요해 내 글을 지우지 않는다(격차 D1).
        // 여기선 텍스트 편집이라 병합 결과(충돌 마커 포함)를 그대로 실어주면 된다.
        const d = (await res.json().catch(() => ({}))) as { currentMarkdown?: string; currentRev?: number };
        const merged = merge3(baseMarkdownRef.current, markdownRef.current, d.currentMarkdown ?? "");
        setMarkdown(merged.text);
        markdownRef.current = merged.text;
        baseMarkdownRef.current = merged.text;
        revRef.current = d.currentRev ?? revRef.current;
        setMode("edit");
        setConflictNote(
          merged.conflicts === 0
            ? "다른 곳에서 먼저 저장돼 자동으로 합쳤습니다. 확인하고 저장하세요."
            : `다른 곳에서 먼저 저장됐습니다. 겹치는 곳 ${merged.conflicts}군데를 <<<<<<< 마커로 표시했으니 정리한 뒤 저장하세요 — 어느 쪽도 지우지 않았습니다.`,
        );
        setState("conflict");
        return;
      }
      if (!res.ok) throw new Error("save failed");
      const d = (await res.json()) as { rev?: number };
      if (typeof d.rev === "number") revRef.current = d.rev;
      setState("saved");
      window.dispatchEvent(new CustomEvent("pages:changed"));
    } catch {
      setState("error");
    }
  };

  const scheduleSave = () => {
    if (!loadedRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(), 800);
  };

  return (
    <div className="ws-editor">
      <input
        className="ws-title-input"
        value={title}
        placeholder="제목 없음"
        onChange={(e) => {
          setTitle(e.target.value);
          titleRef.current = e.target.value;
          scheduleSave();
        }}
        onBlur={() => save()}
      />
      <div className="ws-save-state">
        {state === "saving" && "저장 중…"}
        {state === "saved" && "저장됨 ✓"}
        {state === "error" && "저장 실패 ✗"}
        {state === "conflict" && <span style={{ color: "#E0900F" }}>{conflictNote ?? "다른 곳에서 먼저 수정됨"}</span>}
        {state === "loading" && "불러오는 중…"}
      </div>

      {/* 편집 / 미리보기 탭 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        <button
          className="ws-btn-soft"
          style={
            mode === "edit"
              ? { background: "var(--text-strong)", color: "var(--surface-card)", borderColor: "var(--text-strong)" }
              : undefined
          }
          onClick={() => setMode("edit")}
        >
          편집
        </button>
        <button
          className="ws-btn-soft"
          style={
            mode === "preview"
              ? { background: "var(--text-strong)", color: "var(--surface-card)", borderColor: "var(--text-strong)" }
              : undefined
          }
          onClick={() => setMode("preview")}
        >
          미리보기
        </button>
      </div>

      {mode === "edit" ? (
        <textarea
          style={{
            width: "100%",
            minHeight: "60vh",
            fontFamily: "var(--font-mono)",
            fontSize: 13.5,
            lineHeight: 1.7,
            color: "var(--text-body)",
            background: "var(--surface-sunken)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 10,
            padding: "16px 18px",
            resize: "vertical",
            outline: "none",
            boxSizing: "border-box",
          }}
          value={markdown}
          placeholder="마크다운으로 작성하세요…"
          onChange={(e) => {
            setMarkdown(e.target.value);
            markdownRef.current = e.target.value;
            scheduleSave();
          }}
          onBlur={() => save()}
          disabled={state === "loading"}
        />
      ) : (
        <MarkdownPreview markdown={markdown} />
      )}

      {/* 신뢰도 분석(provenance) */}
      <div style={{ marginTop: 24, borderTop: "1px solid var(--border-subtle)", paddingTop: 16 }}>
        <button className="ws-btn-soft" onClick={runProvenance} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Icon name="flag" size={14} /> 신뢰도 분석
          <Icon name={provOpen ? "chevronDown" : "chevronRight"} size={14} />
        </button>

        {provOpen && (
          <div style={{ marginTop: 12 }}>
            {provLoading && <div className="ws-empty-hint">문서 주장을 분석하는 중입니다(수십 초)…</div>}
            {provErr && <p style={{ fontSize: 12.5, color: "#D14343" }}>{provErr}</p>}
            {provCounts && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                {(Object.keys(TAG_COLOR) as ProvTag[]).map((t) => (
                  <span key={t} style={{ fontSize: 12, fontWeight: 600, color: TAG_COLOR[t], border: `1px solid ${TAG_COLOR[t]}`, borderRadius: 999, padding: "2px 10px" }}>
                    {t} {provCounts[t] ?? 0}
                  </span>
                ))}
              </div>
            )}
            {provClaims && provClaims.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {provClaims.map((c, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 12px", border: "1px solid var(--border-subtle)", borderRadius: 9, background: "var(--surface-card)" }}>
                    <span title={TAG_HINT[c.tag]} style={{ flex: "0 0 auto", fontSize: 10.5, fontWeight: 700, color: TAG_COLOR[c.tag], border: `1px solid ${TAG_COLOR[c.tag]}`, borderRadius: 999, padding: "1px 7px", marginTop: 1 }}>{c.tag}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "var(--text-strong)", lineHeight: 1.5 }}>{c.claim}</div>
                      {c.note && <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 2 }}>{c.note}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {provClaims && provClaims.length === 0 && !provLoading && (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)" }}>분석된 주장이 없습니다.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

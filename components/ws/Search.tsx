"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";

/* 전역 검색 + 물어보기(Vault Q&A). /api/search · /api/ask. */

type Hit = { id: string; title: string; snippet: string };
type Results = { docs: Hit[]; decisions: Hit[] };

type AskSource = { id: string; title: string; kind: "doc" | "decision"; passage: string; heading: string | null };
type AskResult = { question: string; answer: string; mode: "llm" | "extractive" | "empty"; sources: AskSource[] };
type ConceptResult = { query: string; expanded: string[]; mode: "expanded" | "plain"; results: AskSource[] };

type Mode = "search" | "ask" | "concept";

export default function Search() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("search");
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Results | null>(null);
  const [ask, setAsk] = useState<AskResult | null>(null);
  const [concept, setConcept] = useState<ConceptResult | null>(null);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // 검색 모드: 디바운스 라이브 검색. 물어보기 모드는 제출(Enter/버튼) 시에만 호출.
  useEffect(() => {
    if (mode !== "search") return;
    const query = q.trim();
    if (!query) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRes(null);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d: Results) => {
          if (alive) setRes(d);
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, mode]);

  function switchMode(m: Mode) {
    setMode(m);
    setRes(null);
    setAsk(null);
    setConcept(null);
    ref.current?.focus();
  }

  async function submitAsk() {
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true);
    setAsk(null);
    try {
      const r = await fetch(`/api/ask?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      setAsk((await r.json()) as AskResult);
    } catch {
      setAsk({ question: query, answer: "답변을 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.", mode: "empty", sources: [] });
    } finally {
      setLoading(false);
    }
  }

  async function submitConcept() {
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true);
    setConcept(null);
    try {
      const r = await fetch(`/api/search/concept?q=${encodeURIComponent(query)}`, { cache: "no-store" });
      setConcept((await r.json()) as ConceptResult);
    } catch {
      setConcept({ query, expanded: [], mode: "plain", results: [] });
    } finally {
      setLoading(false);
    }
  }

  function submit() {
    if (mode === "ask") submitAsk();
    else if (mode === "concept") submitConcept();
  }

  const total = res ? res.docs.length + res.decisions.length : 0;
  const openSource = (s: AskSource) => (s.kind === "doc" ? router.push(`/p/${s.id}`) : router.push("/docs"));

  return (
    <div className="ws-db" style={{ maxWidth: 760 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name={mode === "ask" ? "comment" : "search"} /> {mode === "ask" ? "물어보기" : mode === "concept" ? "개념 검색" : "검색"}
      </h1>

      <div className="ws-seg" role="group" aria-label="모드" style={{ marginTop: 12, width: "fit-content" }}>
        <button className={`ws-seg-btn${mode === "search" ? " active" : ""}`} onClick={() => switchMode("search")}>
          검색
        </button>
        <button className={`ws-seg-btn${mode === "concept" ? " active" : ""}`} onClick={() => switchMode("concept")}>
          개념
        </button>
        <button className={`ws-seg-btn${mode === "ask" ? " active" : ""}`} onClick={() => switchMode("ask")}>
          물어보기
        </button>
      </div>

      <div className="ws-search" style={{ marginTop: 12, height: 42, flex: "none", maxWidth: "none" }}>
        <Icon name={mode === "ask" ? "comment" : "search"} size={16} />
        <input
          ref={ref}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (mode !== "search" && e.key === "Enter") submit();
          }}
          placeholder={mode === "ask" ? "워크스페이스 문서에 질문하기…" : mode === "concept" ? "개념으로 검색(동의어·연관어 확장)…" : "문서·결정 본문 검색…"}
          aria-label={mode === "ask" ? "질문" : "검색"}
          style={{ fontSize: 14 }}
        />
        {mode !== "search" && (
          <button
            onClick={submit}
            disabled={loading || q.trim() === ""}
            style={{
              border: "1px solid transparent", background: "var(--color-primary)", color: "#fff",
              borderRadius: 8, padding: "6px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer",
              whiteSpace: "nowrap", opacity: loading || q.trim() === "" ? 0.5 : 1,
            }}
          >
            {mode === "ask" ? "질문" : "검색"}
          </button>
        )}
      </div>

      {mode === "ask" ? (
        <AskView loading={loading} ask={ask} q={q} onOpen={openSource} />
      ) : mode === "concept" ? (
        <ConceptView loading={loading} concept={concept} onOpen={openSource} />
      ) : q.trim() === "" ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 18 }}>제목과 본문에서 문서·결정을 검색합니다.</p>
      ) : loading ? (
        <div className="ws-empty-hint" style={{ marginTop: 18 }}>검색 중…</div>
      ) : total === 0 ? (
        <div className="ws-empty-hint" style={{ marginTop: 18 }}>“{q}” 결과가 없어요.</div>
      ) : (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 22 }}>
          {res!.docs.length > 0 && (
            <Group label={`문서 ${res!.docs.length}`} icon="doc" hits={res!.docs} onOpen={(id) => router.push(`/p/${id}`)} />
          )}
          {res!.decisions.length > 0 && (
            <Group label={`결정 ${res!.decisions.length}`} icon="flag" hits={res!.decisions} onOpen={() => router.push(`/docs`)} />
          )}
        </div>
      )}
    </div>
  );
}

const MODE_BADGE: Record<AskResult["mode"], { label: string; color: string }> = {
  llm: { label: "AI 합성", color: "var(--color-primary)" },
  extractive: { label: "근거 발췌", color: "var(--text-muted)" },
  empty: { label: "결과 없음", color: "var(--text-disabled)" },
};

function ConceptView({ loading, concept, onOpen }: { loading: boolean; concept: ConceptResult | null; onOpen: (s: AskSource) => void }) {
  if (loading) return <div className="ws-empty-hint" style={{ marginTop: 18 }}>개념 확장·검색 중…</div>;
  if (!concept) {
    return (
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 18 }}>
        검색어를 동의어·연관 개념으로 확장해 폭넓게 찾습니다. 입력하고 Enter 를 누르세요.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      {concept.expanded.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontWeight: 600 }}>확장어</span>
          {concept.expanded.map((t) => (
            <span key={t} style={{ fontSize: 11.5, color: "var(--text-sub)", border: "1px solid var(--border-subtle)", borderRadius: 999, padding: "1px 9px" }}>{t}</span>
          ))}
        </div>
      )}
      {concept.results.length === 0 ? (
        <div className="ws-empty-hint">관련 문서를 찾지 못했어요.</div>
      ) : (
        <section>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 8 }}>관련 {concept.results.length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {concept.results.map((s) => (
              <button
                key={`${s.kind}-${s.id}`}
                onClick={() => onOpen(s)}
                style={{ textAlign: "left", border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", padding: "11px 14px", cursor: "pointer", font: "inherit" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 600, color: "var(--text-strong)" }}>
                  <Icon name={s.kind === "doc" ? "doc" : "flag"} size={13} />
                  {s.title}
                  {s.heading && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>› {s.heading}</span>}
                </div>
                {s.passage && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>{s.passage}</div>}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function AskView({ loading, ask, q, onOpen }: { loading: boolean; ask: AskResult | null; q: string; onOpen: (s: AskSource) => void }) {
  if (loading) return <div className="ws-empty-hint" style={{ marginTop: 18 }}>답변 생성 중…</div>;
  if (!ask) {
    return (
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 18 }}>
        워크스페이스 문서·결정을 근거로 답합니다. 질문을 입력하고 Enter 를 누르세요.
        {q.trim() === "" ? "" : " (Enter 로 질문)"}
      </p>
    );
  }
  const badge = MODE_BADGE[ask.mode];
  return (
    <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 11.5, fontWeight: 700, color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 999, padding: "1px 8px" }}>
            {badge.label}
          </span>
        </div>
        <div style={{ fontSize: 13.5, color: "var(--text-strong)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{ask.answer}</div>
      </div>

      {ask.sources.length > 0 && (
        <section>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 8 }}>출처 {ask.sources.length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ask.sources.map((s, i) => (
              <button
                key={`${s.kind}-${s.id}`}
                onClick={() => onOpen(s)}
                style={{ textAlign: "left", border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", padding: "11px 14px", cursor: "pointer", font: "inherit" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 600, color: "var(--text-strong)" }}>
                  <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>[{i + 1}]</span>
                  <Icon name={s.kind === "doc" ? "doc" : "flag"} size={13} />
                  {s.title}
                  {s.heading && <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text-muted)" }}>› {s.heading}</span>}
                </div>
                {s.passage && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>{s.passage}</div>}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Group({ label, icon, hits, onOpen }: { label: string; icon: "doc" | "flag"; hits: Hit[]; onOpen: (id: string) => void }) {
  return (
    <section>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name={icon} size={14} /> {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {hits.map((h) => (
          <button
            key={h.id}
            onClick={() => onOpen(h.id)}
            style={{ textAlign: "left", border: "1px solid var(--border-subtle)", borderRadius: 10, background: "var(--surface-card)", padding: "11px 14px", cursor: "pointer", font: "inherit" }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-strong)" }}>{h.title}</div>
            {h.snippet && <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>{h.snippet}</div>}
          </button>
        ))}
      </div>
    </section>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { Icon } from "./icons";

/* 웹 클리퍼 진입점 — 북마클릿이 /clip#<payload> 로 열면 자동 저장, 아니면 수동 붙여넣기.
   동일 출처라 세션 쿠키가 정상 전달된다. /api/clip 이 요약·프로젝트 자동분류 후 문서 생성. */

type Result = { ok: boolean; pageId: string; projectName: string | null; summary: string; mode: string };
type Status = "idle" | "saving" | "done" | "error";

export default function Clip() {
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const bmRef = useRef<HTMLAnchorElement>(null);

  async function submit(payload: { url: string; title: string; text: string }) {
    if (!payload.text.trim() && !payload.url.trim()) return;
    setStatus("saving");
    setErr(null);
    try {
      const r = await fetch("/api/clip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = (await r.json()) as Result & { error?: string };
      if (!r.ok || !d.ok) {
        setErr(d.error ?? "저장에 실패했습니다.");
        setStatus("error");
        return;
      }
      setResult(d);
      setStatus("done");
    } catch {
      setErr("저장 중 오류가 발생했습니다.");
      setStatus("error");
    }
  }

  useEffect(() => {
    // 북마클릿 href 를 ref 로 직접 설정(React 의 javascript: URL sanitize 회피)
    if (bmRef.current) {
      const o = window.location.origin;
      bmRef.current.setAttribute(
        "href",
        `javascript:(function(){var s=(window.getSelection&&window.getSelection().toString())||'';var t=s||document.body.innerText||'';t=t.slice(0,20000);window.open('${o}/clip#'+encodeURIComponent(JSON.stringify({u:location.href,t:document.title,x:t})),'_blank');})();`,
      );
    }
    // 해시 페이로드 → 자동 저장
    const h = window.location.hash.slice(1);
    if (h) {
      try {
        const p = JSON.parse(decodeURIComponent(h)) as { u?: string; t?: string; x?: string };
        window.history.replaceState(null, "", window.location.pathname); // 새로고침 재제출 방지
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void submit({ url: p.u ?? "", title: p.t ?? "", text: p.x ?? "" });
      } catch {
        /* 잘못된 해시 무시 */
      }
    }
  }, []);

  return (
    <div className="ws-db" style={{ maxWidth: 720 }}>
      <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="link" /> 웹 클리퍼
      </h1>

      {status === "saving" && <div className="ws-empty-hint" style={{ marginTop: 16 }}>저장하고 요약·분류하는 중입니다…</div>}

      {status === "done" && result && (
        <div style={{ ...card, marginTop: 16, borderColor: "var(--color-primary)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700, color: "var(--text-strong)" }}>
            <Icon name="check" size={16} /> 저장했어요
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 6 }}>
            프로젝트: {result.projectName ?? "미분류"} · {result.mode === "classified" ? "AI 분류·요약" : "원문 저장"}
          </div>
          {result.summary && <p style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 8, lineHeight: 1.6 }}>{result.summary}</p>}
          <Link href={`/p/${result.pageId}`} style={{ ...primary, display: "inline-block", marginTop: 12, textDecoration: "none" }}>문서 열기</Link>
        </div>
      )}

      {status === "error" && <p style={{ fontSize: 13, color: "#D14343", marginTop: 16 }}>{err}</p>}

      {/* 북마클릿 설치 */}
      <Section title="북마클릿 설치">
        <p style={hint}>아래 링크를 브라우저 <b>북마크바로 드래그</b>하세요. 웹페이지에서 클릭하면(텍스트를 선택했으면 그 부분만) 이 워크스페이스로 저장됩니다.</p>
        <a ref={bmRef} href="/clip" onClick={(e) => e.preventDefault()} style={{ ...bmChip, marginTop: 8 }}>
          <Icon name="link" size={14} /> TeamSpace 클립
        </a>
      </Section>

      {/* 수동 붙여넣기 */}
      <Section title="직접 붙여넣기">
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL (선택)" style={inp} />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="제목 (선택)" style={{ ...inp, marginTop: 8 }} />
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="저장할 본문 텍스트" rows={6} style={{ ...inp, marginTop: 8, resize: "vertical" }} />
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <span style={{ flex: 1 }} />
          <button
            style={primary}
            disabled={status === "saving" || (!text.trim() && !url.trim())}
            onClick={() => submit({ url, title, text })}
          >
            저장
          </button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

const card: CSSProperties = { border: "1px solid var(--border-subtle)", borderRadius: 12, background: "var(--surface-card)", padding: 16 };
const inp: CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", fontSize: 13, fontFamily: "inherit" };
const primary: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff" };
const hint: CSSProperties = { fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 };
const bmChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 14px", borderRadius: 9, border: "1px dashed var(--color-primary)", background: "var(--surface-card)", color: "var(--color-primary)", fontSize: 13, fontWeight: 700, textDecoration: "none", cursor: "grab" };

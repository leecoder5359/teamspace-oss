"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import type { Mermaid } from "mermaid";
import { resolveMermaidTheme, type MermaidTheme } from "@/lib/md/mermaidTheme";

/* =====================================================================
   ```mermaid 코드 블록 → SVG 다이어그램.

   mermaid 는 무겁다(수백 KB) — 다이어그램이 있는 문서에서만 마운트 후
   동적 import 한다. initialize 는 페이지당 한 번만(모듈 전역 promise).
   securityLevel "strict" 가 라벨의 HTML 을 sanitize 하고 클릭 핸들러를
   막으므로 결과 svg 를 innerHTML 로 꽂아도 된다 — 문서 본문은 에이전트도
   쓰는 비신뢰 입력이다.
   ===================================================================== */

/** 지금 앱 테마: <html data-theme> 우선, 없으면 prefers-color-scheme. */
function currentTheme(): MermaidTheme {
  return resolveMermaidTheme(document.documentElement.dataset.theme, window.matchMedia("(prefers-color-scheme: dark)").matches);
}

let mermaidReady: Promise<Mermaid> | null = null;
let appliedTheme: MermaidTheme | null = null;
/** 테마가 바뀐 뒤에만 다시 initialize 한다(블록마다 부르지 않는다). */
function applyTheme(mermaid: Mermaid, theme: MermaidTheme) {
  if (appliedTheme === theme) return;
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
  appliedTheme = theme;
}
function loadMermaid(): Promise<Mermaid> {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then(({ default: mermaid }) => mermaid);
    // 청크 로드 실패는 다음 시도에서 다시 받게 한다
    mermaidReady.catch(() => {
      mermaidReady = null;
    });
  }
  return mermaidReady;
}

type Result = { code: string; svg: string } | { code: string; error: true };

export default function MermaidBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  // useId 는 ':' '«' 같은 글자를 담을 수 있다 — mermaid 는 id 를 CSS 선택자로 쓰므로 걸러 낸다
  const renderId = "mmd-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [result, setResult] = useState<Result | null>(null);
  // 앱 테마 — 마운트 뒤에 읽고(SSR 에는 document 가 없다), 바뀌면 다시 그린다
  const [theme, setTheme] = useState<MermaidTheme | null>(null);

  useEffect(() => {
    const update = () => setTheme(currentTheme());
    update();
    const mo = new MutationObserver(update);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", update);
    return () => {
      mo.disconnect();
      mq.removeEventListener?.("change", update);
    };
  }, []);

  useEffect(() => {
    if (!theme) return;
    let alive = true;
    loadMermaid()
      .then((mermaid) => {
        applyTheme(mermaid, theme);
        return mermaid.render(renderId, code);
      })
      .then(({ svg }) => {
        if (alive) setResult({ code, svg });
      })
      .catch(() => {
        // 실패 시 mermaid 가 body 에 남기는 임시 요소 정리
        document.getElementById("d" + renderId)?.remove();
        document.getElementById(renderId)?.remove();
        if (alive) setResult({ code, error: true });
      });
    return () => {
      alive = false;
    };
  }, [code, renderId, theme]);

  // 결과가 지금 code 의 것일 때만 쓴다 — code 가 바뀌면 새 결과가 올 때까지 원문
  const current = result && result.code === code ? result : null;
  if (current && "svg" in current) {
    return <div className="ws-mermaid" style={{ overflowX: "auto", margin: "10px 0" }} dangerouslySetInnerHTML={{ __html: current.svg }} />;
  }
  return (
    <>
      {fallback}
      {current && <div style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "-4px 0 10px" }}>다이어그램을 그리지 못했어요 — 원문 표시</div>}
    </>
  );
}

"use client";

import { useEffect } from "react";
import { ERROR_COPY } from "@/components/ErrorScreen";

// 루트 레이아웃까지 깨진 경우 — 스타일시트가 안 올 수 있어 인라인 최소 스타일만 쓴다.
export default function GlobalError({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const btn = { height: 44, borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer", border: "1px solid #ccd", background: "#fff", color: "#222", textDecoration: "none", display: "flex", alignItems: "center", justifyContent: "center" } as const;

  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f6f7f9", color: "#111" }}>
        <div style={{ minHeight: "100dvh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ width: "100%", maxWidth: 380, background: "#fff", border: "1px solid #e3e5ea", borderRadius: 20, padding: 28 }}>
            <h1 style={{ margin: 0, fontSize: 19 }}>{ERROR_COPY.errorTitle}</h1>
            <p style={{ margin: "6px 0 20px", fontSize: 13, lineHeight: 1.5, color: "#555" }}>{ERROR_COPY.errorBody}</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button style={btn} onClick={() => unstable_retry()}>다시 시도</button>
              {/* 루트 레이아웃이 깨졌을 수 있어 전체 새로고침이 필요하다 — Link 대신 a */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a style={btn} href="/">홈으로</a>
            </div>
            {error.digest && <p style={{ margin: "16px 0 0", fontSize: 11, color: "#888" }}>오류 코드: {error.digest}</p>}
          </div>
        </div>
      </body>
    </html>
  );
}

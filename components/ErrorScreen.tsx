import type { ReactNode } from "react";
import Link from "next/link";

// 404·오류 화면 공통 마크업 — 서버/클라이언트 양쪽에서 쓰므로 훅 없음.
// 로그인 화면과 같은 카드·ws-* 버튼 클래스를 재사용한다(새 모양 없음).
export const ERROR_COPY = {
  notFoundTitle: "페이지를 찾을 수 없어요",
  notFoundBody: "주소가 바뀌었거나 삭제된 문서일 수 있어요.",
  errorTitle: "문제가 생겼어요",
  errorBody: "잠시 후 다시 시도해 주세요. 계속되면 관리자에게 알려 주세요.",
};

export function ErrorHomeLink() {
  return (
    <Link className="ws-ghost-btn" href="/" style={{ textDecoration: "none" }}>
      홈으로
    </Link>
  );
}

export function ErrorScreen({
  title,
  body,
  actions,
  digest,
}: {
  title: string;
  body: string;
  actions?: ReactNode;
  digest?: string;
}) {
  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 20px",
        background: "var(--surface-page)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 380,
          background: "var(--surface-card)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 20,
          padding: 28,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: "var(--text-strong)" }}>{title}</h1>
        <p style={{ margin: "6px 0 20px", fontSize: 13, lineHeight: 1.5, color: "var(--text-sub)" }}>{body}</p>
        {actions && <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{actions}</div>}
        {digest && (
          <p style={{ margin: "16px 0 0", fontSize: 11, color: "var(--text-muted)" }}>오류 코드: {digest}</p>
        )}
      </div>
    </div>
  );
}

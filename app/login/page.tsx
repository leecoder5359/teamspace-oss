"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { Icon } from "@/components/ws/icons";
import { safeCallbackPath } from "@/lib/redirectSafety";

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export default function LoginPage() {
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [authError, setAuthError] = useState<string | null>(null);

  // 로그인 거부/오류 시 NextAuth 가 ?error= 로 되돌려보낸다.
  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get("error");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (err) setAuthError(err);
  }, []);

  const errorMessage =
    authError === "AccessDenied"
      ? "이 워크스페이스에 초대된 계정이거나 허용된 도메인의 이메일만 로그인할 수 있어요. 외부에서 공유받은 페이지라면 받은 링크(/s/…)를 초대받은 이메일 계정으로 여세요."
      : authError
        ? "로그인 중 문제가 발생했어요. 다시 시도해 주세요."
        : null;

  // middleware.ts 가 미인증 접근 시 원래 목적지를 ?callbackUrl= 로 넘겨준다(예: /setup/pair?code=...).
  // 오픈 리다이렉트 방지 검증은 lib/redirectSafety.ts 의 safeCallbackPath 순수함수에 위임한다.
  const resolveRedirectTo = () => {
    const raw = new URLSearchParams(window.location.search).get("callbackUrl");
    return safeCallbackPath(raw);
  };

  const continueWithGoogle = () => {
    const to = resolveRedirectTo();
    // 공유 페이지로 돌아가는 로그인은 계정 선택 화면을 띄운다 — 브라우저에 로그인된
    // 다른 Google 계정으로 자동 진행돼 '권한 없음'에 갇히는 것을 막는다.
    void signIn("google", { redirectTo: to }, to.startsWith("/s/") ? { prompt: "select_account" } : undefined);
  };

  const createWorkspace = () => {
    // 단일 워크스페이스 MVP — 등록 UI는 유지하되 동작은 준비 중.
    alert("준비 중입니다 — 현재는 단일 워크스페이스만 지원해요.");
  };

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 22,
        padding: "40px 20px",
        background: "var(--surface-page)",
      }}
    >
      {/* 브랜드 */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 56,
            height: 56,
            borderRadius: 16,
            background: "var(--color-primary)",
            color: "#fff",
          }}
        >
          <Icon name="logo" size={46} />
        </span>
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 24,
            fontWeight: 700,
            color: "var(--text-strong)",
          }}
        >
          리코더팩토리
        </span>
        <span style={{ fontSize: 13, color: "var(--text-sub)" }}>팀 QA 워크스페이스</span>
      </div>

      {/* 카드 */}
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
        {mode === "signin" ? (
          <>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: "var(--text-strong)" }}>
              로그인
            </h2>
            <p style={{ margin: "6px 0 20px", fontSize: 13, color: "var(--text-sub)" }}>
              워크스페이스 계정으로 계속하세요
            </p>

            {errorMessage && (
              <div
                role="alert"
                style={{
                  display: "flex",
                  gap: 9,
                  marginBottom: 16,
                  padding: 12,
                  background: "var(--surface-danger, #fdecea)",
                  border: "1px solid var(--border-danger, #f5c6cb)",
                  borderRadius: 10,
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: "var(--text-danger, #b3261e)",
                }}
              >
                {errorMessage}
              </div>
            )}

            <button className="ws-google-btn" onClick={continueWithGoogle}>
              <GoogleG />
              Google로 계속하기
            </button>

            <button className="ws-email-btn" onClick={continueWithGoogle}>
              <Icon name="doc" size={16} />
              이메일로 계속하기
            </button>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: "16px 0",
                color: "var(--text-muted)",
                fontSize: 12,
              }}
            >
              <span style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
              또는
              <span style={{ flex: 1, height: 1, background: "var(--border-subtle)" }} />
            </div>

            <button className="ws-ghost-btn" onClick={() => setMode("register")}>
              <Icon name="plus" size={16} />새 워크스페이스 만들기
            </button>

            <div
              style={{
                display: "flex",
                gap: 9,
                marginTop: 18,
                padding: 13,
                background: "var(--surface-sunken)",
                borderRadius: 10,
              }}
            >
              <span style={{ color: "var(--color-primary)", flex: "0 0 auto", marginTop: 1 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 21s-7-5.686-7-11a7 7 0 0 1 14 0c0 5.314-7 11-7 11z" />
                  <circle cx="12" cy="10" r="2.5" />
                </svg>
              </span>
              <span style={{ fontSize: 12, lineHeight: 1.55, color: "var(--text-sub)" }}>
                로그인하면 소속된 워크스페이스 내부 자료에만 접근해요. 외부에는 공유되지 않습니다.
              </span>
            </div>
          </>
        ) : (
          <>
            <button className="ws-link" onClick={() => setMode("signin")} style={{ marginBottom: 12 }}>
              ← 로그인으로
            </button>
            <h2 style={{ margin: 0, fontSize: 19, fontWeight: 700, color: "var(--text-strong)" }}>
              새 워크스페이스 만들기
            </h2>
            <p style={{ margin: "6px 0 18px", fontSize: 13, color: "var(--text-sub)" }}>
              팀 이름과 도메인을 입력하세요
            </p>

            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--text-body)", marginBottom: 6 }}>
              워크스페이스 이름
            </label>
            <input
              type="text"
              placeholder="예: 리코더팩토리"
              style={{
                width: "100%",
                height: 42,
                padding: "0 12px",
                marginBottom: 14,
                borderRadius: 10,
                border: "1px solid var(--border-default)",
                background: "var(--surface-card)",
                color: "var(--text-strong)",
                fontSize: 14,
                fontFamily: "inherit",
                outline: "none",
              }}
            />

            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--text-body)", marginBottom: 6 }}>
              도메인 <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>(선택)</span>
            </label>
            <input
              type="text"
              placeholder="example.com"
              style={{
                width: "100%",
                height: 42,
                padding: "0 12px",
                marginBottom: 18,
                borderRadius: 10,
                border: "1px solid var(--border-default)",
                background: "var(--surface-card)",
                color: "var(--text-strong)",
                fontSize: 14,
                fontFamily: "inherit",
                outline: "none",
              }}
            />

            <button
              onClick={createWorkspace}
              style={{
                width: "100%",
                height: 46,
                borderRadius: 11,
                border: "none",
                background: "var(--color-primary)",
                color: "var(--color-on-primary)",
                fontSize: 14,
                fontWeight: 600,
                fontFamily: "inherit",
                cursor: "pointer",
              }}
            >
              워크스페이스 만들기
            </button>
          </>
        )}
      </div>

      <p style={{ maxWidth: 360, textAlign: "center", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-muted)" }}>
        계속 진행하면 서비스 약관과 개인정보 처리방침에 동의하는 것으로 간주됩니다.
      </p>
    </div>
  );
}

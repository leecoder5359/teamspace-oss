import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

// 엣지 안전 설정(JWT 세션)으로 Auth.js 미들웨어를 구성한다(Prisma 어댑터 미포함).
const { auth } = NextAuth(authConfig);

// 자체 인증/공개 API (세션·CLI 토큰 없이 통과):
//   /api/auth                 — OAuth 콜백·signin
//   /api/health               — 무인증 최소 상태(모니터링 프로브)
//   /api/ingest               — HMAC 서명(x-ingest-signature)으로 자체 인증
//   /api/slack/interactions   — 슬랙 서명으로 자체 인증
//   /api/setup                — curl 설치기가 로그인 전에 받는 공개 스크립트(화이트리스트 파일만 서빙)
//   /api/site-intake          — 퍼블리시 사이트 폼 제출. /pub 프록시가 쿠키·authorization 을 떼고 넘기므로
//                              세션으로는 올 수 없다. 프록시 서명(x-teamspace-proxy-sig) + 초대 재판정이
//                              자체 인증 게이트다(app/api/site-intake/route.ts). 쓰기 전용 — 읽기 경로가 없다.
//   /api/pair/<code>(/route-rule) — CLI 가 로그인 쿠키 없이 호출하는 페어링 폴링·route-rule 등록.
//                              페어링 코드(만료·존재 검증)가 자체 인증 게이트 — requireCtx 불필요.
//                              /api/pair/approve 는 예외 — 브라우저 Google 로그인 세션이 증명 수단이므로
//                              requireCtx("admin") 세션 게이트를 유지해야 한다(공개하면 익명 승인 가능해짐).
function isOpenApi(pathname: string): boolean {
  return (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/api/ingest") ||
    pathname.startsWith("/api/slack/interactions") ||
    pathname.startsWith("/api/setup") ||
    pathname === "/api/site-intake" ||
    (pathname.startsWith("/api/pair/") &&
      !(pathname === "/api/pair/approve" || pathname.startsWith("/api/pair/approve/")))
  );
}

// curl|sh 원라이너가 로그인 전에 fetch 하는 공개 자산(next.config.ts rewrites 의 원본 경로).
// 미들웨어(Proxy)는 rewrite 적용 전 원본 URL을 보므로 /api/setup 화이트리스트와 별개로
// /setup.sh, /setup/hooks/* 자체도 여기서 공개해야 한다. (/setup/pair 는 제외 — 로그인 게이트 유지.)
function isPublicSetupAsset(pathname: string): boolean {
  return pathname === "/setup.sh" || pathname.startsWith("/setup/hooks/");
}

export default auth((req) => {
  const { pathname } = req.nextUrl;

  if (isPublicSetupAsset(pathname)) return;

  // 퍼블리시 사이트 파일(/pub/<token>/…): 샌드박스 iframe 요청엔 세션 쿠키가 없다.
  // 인증은 라우트가 서명 토큰 + 매 요청 초대 재판정으로 한다(app/pub/[token]/[...path]/route.ts).
  if (pathname.startsWith("/pub/")) return;

  // ── API 보호 (fail-closed) ──
  // 엣지 미들웨어는 DB 를 못 보므로 토큰은 "존재"만 확인하고, 실제 검증
  // (레거시 timing-safe 비교·AgentToken 해시 조회·RBAC)은 라우트의 requireCtx 가 수행한다.
  // scripts/authz-coverage.test.ts 가 모든 라우트의 requireCtx 채택을 정적 강제한다.
  if (pathname.startsWith("/api")) {
    if (isOpenApi(pathname)) return;
    if (req.auth) return;
    if (req.headers.get("x-ws-token")) return; // 검증은 requireCtx 에서
    if (process.env.AUTH_OPEN_API === "true") return; // 데모/로컬 명시적 개방
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // ── UI 페이지 보호: 미인증 → /login ──
  if (pathname.startsWith("/login")) return;
  if (!req.auth) {
    // 로그인 후 원래 화면(예: /setup/pair?code=...)으로 돌아올 수 있도록 목적지를 함께 넘긴다.
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }
  return;
});

export const config = {
  // public 정적 자산(/fonts/*)·_next·favicon 은 인증 미들웨어에서 제외(미인증 화면에서도 폰트 로드).
  //
  // PWA(격차 F1)도 여기서 뺀다 — sw.js·매니페스트·아이콘·오프라인 안내에는
  // 워크스페이스 데이터가 한 글자도 없고, 로그인 리다이렉트가 걸리면
  // 서비스 워커 등록이 MIME 오류로 실패하고 설치 배너도 안 뜬다.
  //
  // **`api/import` 는 미들웨어를 타지 않는다** — 인증을 느슨하게 하려는 게 아니라
  // 엣지 미들웨어가 **요청 본문을 버퍼링하면서 ~10MB 를 넘는 multipart 를 깨뜨리기**
  // 때문이다. 실측(2026-08-09): 8MB 통과 / 10MB·12MB·17MB 는 라우트에 닿기도 전에
  // 본문이 잘려 `Failed to parse body as FormData` 로 죽었다. 라우트는 50MB 를
  // 광고하는데 우리 워크스페이스 전체 export(17MB)조차 다시 못 넣는 상태였다 —
  // 즉 '자기 백업을 자기가 못 읽는' 계약 위반이다.
  //
  // 안전은 그대로다: `/api/import` 의 첫 줄이 `requireCtx("editor")` 이고 그게
  // **본문을 읽기 전에** 401/403 을 낸다(미인증 요청은 zip 을 한 바이트도 안 읽는다).
  // 미들웨어의 역할은 어차피 fail-closed 선차단이고 실제 검증은 requireCtx 다.
  // scripts/authz-coverage.test.ts 가 "matcher 에서 뺀 /api 경로는 requireCtx 를
  // 쓴다" 를 정적으로 강제한다 — 이 예외가 조용히 무인증 구멍이 되지 않도록.
  // **`api/sites` 도 같은 사유로 뺀다**(HTML 퍼블리시 zip 업로드 20MB). 첫 줄 requireCtx 가 게이트다.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|fonts|icons|sw.js|manifest.webmanifest|offline|api/import|api/sites).*)",
  ],
};

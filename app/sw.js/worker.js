/* =====================================================================
   서비스 워커 (격차 F1) — 오프라인·설치형.

   **가장 중요한 원칙: 워크스페이스 데이터는 절대 캐시하지 않는다.**
   태스크 상태·문서 본문은 낡은 걸 보여 주는 순간 거짓말이 된다("완료로 바꿨는데
   아직 진행 중이네?"). 그래서 `/api/*` 는 네트워크 전용이고, 캐시는
   ① 불변 정적 자산(_next/static, 아이콘) ② 오프라인 안내 페이지
   두 가지에만 쓴다.

   두 번째 원칙: **망가진 워커가 앱을 벽돌로 만들 수 있다.** 그래서
   - 내비게이션은 네트워크 우선(성공하면 항상 최신 HTML)
   - 새 버전은 즉시 인수(skipWaiting + clients.claim)
   - 배포마다 캐시 이름이 바뀌고 옛 캐시는 지운다
   - `/sw.js?disable=1` 로 스스로 등록 해제하는 탈출구
   ===================================================================== */

// 배포마다 갈리는 값. /sw.js 를 서빙하는 라우트가 __BUILD__ 를 바꿔 넣는다.
const VERSION = "__BUILD__";
const STATIC_CACHE = `ts-static-${VERSION}`;
const SHELL_CACHE = `ts-shell-${VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // 오프라인 안내는 미리 받아 둔다 — 정작 오프라인일 때 받을 수 없으니.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" })).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("ts-") && !k.endsWith(VERSION)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "unregister") void self.registration.unregister();
});

const isStatic = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  url.pathname.startsWith("/icons/") ||
  url.pathname.startsWith("/fonts/");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 워크스페이스 데이터·인증·SSE 는 손대지 않는다. 낡은 데이터는 없는 것보다 나쁘다.
  if (url.pathname.startsWith("/api/")) return;

  // 불변 정적 자산: 캐시 우선(빌드마다 해시가 바뀌므로 낡을 일이 없다)
  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(STATIC_CACHE);
          void cache.put(req, res.clone());
        }
        return res;
      })(),
    );
    return;
  }

  // 화면(HTML): 네트워크 우선, 실패하면 오프라인 안내
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cached = await caches.match(OFFLINE_URL);
          return (
            cached ??
            new Response("<h1>오프라인</h1><p>네트워크에 연결되면 다시 시도하세요.</p>", {
              status: 503,
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          );
        }
      })(),
    );
  }
});

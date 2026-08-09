"use client";

import { useEffect } from "react";

/* =====================================================================
   서비스 워커 등록 (격차 F1).

   등록만 하고 아무것도 하지 않는다 — 캐시 정책은 워커 안에 있다.

   **킬 스위치**: 주소에 `?sw=off` → 등록 해제 + 캐시 삭제 + 그 선택을 기억한다
   (`?sw=on` 으로 해제). 서비스 워커는 잘못 배포되면 앱을 벽돌로 만들 수 있고,
   그때 사용자에게 "개발자도구를 열어 unregister 하세요" 라고 할 수는 없다.
   기억하지 않으면 다음 방문에 곧바로 다시 등록돼 탈출구가 되지 못한다.
   ===================================================================== */

export default function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const params = new URLSearchParams(window.location.search);
    const flag = params.get("sw");

    // 킬 스위치를 **기억**한다. unregister 만으로는 부족하다 —
    // 이미 이 페이지를 제어 중인 워커는 새로고침 전까지 계속 제어하므로
    // 캐시가 그 사이에 다시 만들어지고, 다음 방문엔 또 등록된다.
    if (flag === "off") localStorage.setItem("ws-sw", "off");
    if (flag === "on") localStorage.removeItem("ws-sw");
    const disabled = localStorage.getItem("ws-sw") === "off";

    const cleanup = async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith("ts-")).map((k) => caches.delete(k)));
      }
    };

    if (flag === "off") {
      void (async () => {
        await cleanup();
        // 제어를 확실히 끊으려면 한 번 새로고침해야 한다. 쿼리는 떼고 간다
        // (안 떼면 새로고침마다 같은 처리가 반복된다).
        window.location.replace(window.location.pathname);
      })();
      return;
    }
    if (disabled) {
      // 껐다고 기억하는 동안에는 남은 워커·캐시만 치우고 등록하지 않는다.
      void cleanup();
      console.info("[sw] 사용 안 함(ws-sw=off). 다시 켜려면 주소에 ?sw=on 을 붙이세요.");
      return;
    }

    // 로컬 개발(next dev)에서는 굳이 붙이지 않는다 — HMR 과 섞이면 원인 찾기가 어려워진다.
    if (process.env.NODE_ENV !== "production") return;
    const t = setTimeout(() => {
      void navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("[sw] 등록 실패", e));
    }, 1500); // 첫 화면 렌더를 방해하지 않도록 뒤로 미룬다
    return () => clearTimeout(t);
  }, []);

  return null;
}

"use client";

import { useEffect, useRef } from "react";
import { createEventHub, type EventHub } from "./eventHub";

/**
 * 화면 자동 갱신 훅 (W6 폴링 → W8 SSE 업그레이드).
 * 1) /api/events SSE 연결 성공 시: activity/notification 이벤트마다 refetch(500ms 디바운스),
 *    안전망으로 5분 간격 폴링만 유지.
 * 2) SSE 실패/미지원: 기존 30초 폴링 폴백.
 * 창 포커스/가시성 복귀 시엔 항상 refetch. 호출부 시그니처는 W6 그대로.
 * SSE 연결은 탭 전체가 하나를 나눠 쓰고 숨은 탭에선 닫는다(lib/eventHub, 감사 P-6).
 */
let hub: EventHub | null = null;
function sharedHub(): EventHub {
  hub ??= createEventHub({
    open: () => new EventSource("/api/events"),
    isHidden: () => document.hidden,
    watchVisibility: (onChange) => {
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    },
  });
  return hub;
}

export function useAutoRefresh(refetch: () => void, intervalMs = 30_000): void {
  const fnRef = useRef(refetch);
  useEffect(() => {
    fnRef.current = refetch;
  }, [refetch]);

  useEffect(() => {
    let pollMs = intervalMs;
    let iv: ReturnType<typeof setInterval> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;

    const startPolling = () => {
      if (iv) clearInterval(iv);
      iv = setInterval(() => fnRef.current(), pollMs);
    };

    startPolling();
    const unsubscribe = sharedHub().subscribe({
      onHello: () => {
        pollMs = 300_000; // SSE 활성 → 폴링은 5분 안전망으로 완화
        startPolling();
      },
      onEvent: () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => fnRef.current(), 500);
      },
      onError: () => {
        // 연결 실패/끊김 → 30초 폴링 폴백 (EventSource 가 자동 재연결도 시도)
        pollMs = intervalMs;
        startPolling();
      },
    });

    const onFocus = () => fnRef.current();
    const onVisible = () => {
      if (document.visibilityState === "visible") fnRef.current();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (iv) clearInterval(iv);
      if (debounce) clearTimeout(debounce);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);
}

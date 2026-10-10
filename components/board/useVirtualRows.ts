"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_ROW_HEIGHT, findScrollParent, scrollsY, windowRange } from "@/lib/virtualRows";

type Metrics = { scrollTop: number; viewportHeight: number; offsetTop: number };

function readMetrics(anchor: HTMLElement, parent: HTMLElement | Window): Metrics {
  const top = anchor.getBoundingClientRect().top;
  // 고른 부모가 지금 실제로 세로 스크롤하지 않으면(판단이 틀렸거나 레이아웃이 바뀜) window 기준으로 읽는다.
  if (parent === window || !scrollsY(parent as HTMLElement)) {
    return { scrollTop: window.scrollY, viewportHeight: window.innerHeight, offsetTop: top + window.scrollY };
  }
  const p = parent as HTMLElement;
  return {
    scrollTop: p.scrollTop,
    viewportHeight: p.clientHeight,
    // tbody 가 스크롤 부모 "콘텐츠" 안에서 시작하는 y = 화면상 차이 + 이미 스크롤한 양
    offsetTop: top - p.getBoundingClientRect().top - p.clientTop + p.scrollTop,
  };
}

/** 앵커(tbody) 의 첫 실제 행 — 스페이서(aria-hidden) 는 건너뛴다. */
function firstRealRow(anchor: HTMLElement): HTMLElement | null {
  for (const el of Array.from(anchor.children)) {
    if (el.getAttribute("aria-hidden") !== "true") return el as HTMLElement;
  }
  return null;
}

/**
 * 보드 표 뷰의 보이는 행 창(P-1). 계산은 lib/virtualRows.windowRange 에 맡기고,
 * 여기서는 스크롤·resize·행 크기 변화를 rAF 로 묶어 측정값만 갱신한다.
 * 범위 자체는 렌더 중에 (측정값, total) 에서 파생하므로 정렬·필터로 total 이 바뀌면 바로 반영된다.
 * enabled=false 면 {0,total,0,0} — 리스너도 걸지 않는다.
 *
 * - 스크롤: document 캡처 단계로 받아 어느 조상(또는 window)이 스크롤해도 창이 움직인다.
 *   스크롤 부모는 scrollTop·viewportHeight·offsetTop 계산용으로만 쓰고, enabled 가 켜질 때·total 이 바뀔 때 다시 찾는다.
 * - 행 높이: 켜질 때 첫 실제 행을 한 번 잰다. 이후엔 "같은 요소" 의 크기가 바뀔 때만(밀도·폭 변경) 갱신한다.
 *   그 행이 창 밖으로 빠져 언마운트되면 새 첫 행에 관찰만 옮기고, 그 첫 측정값은 기준으로만 삼는다 —
 *   행마다 높이가 달라도 rowHeight 가 첫 행을 따라 출렁이지 않게(I1).
 */
export function useVirtualRows(opts: {
  anchorRef: React.RefObject<HTMLElement | null>;
  total: number;
  enabled: boolean;
}): {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
  rowHeight: number;
} {
  const { anchorRef, total, enabled } = opts;
  // 측정 전 초기값: 맨 위에서 창 높이만큼 보인다고 가정(lazy init — effect 안 setState 금지).
  const [metrics, setMetrics] = useState<Metrics>(() => ({
    scrollTop: 0,
    viewportHeight: typeof window === "undefined" ? 0 : window.innerHeight,
    offsetTop: 0,
  }));
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  // 행 높이를 한 번이라도 쟀는가(마운트 동안 유지 — total 변화로 effect 가 다시 돌아도 재시드하지 않는다).
  const measuredRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const parent = findScrollParent(anchor);

    // 관찰 중인 행과 그 행의 직전 높이(-1 = 아직 첫 보고 전)
    let observed: HTMLElement | null = null;
    let observedH = -1;
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target !== observed) continue;
              const h = (entry.target as HTMLElement).offsetHeight;
              if (h <= 0) continue;
              const prevH = observedH;
              observedH = h;
              if (prevH === -1) {
                // 관찰 시작 보고: 활성화 후 최초 측정일 때만 rowHeight 로 쓴다.
                if (!measuredRef.current) {
                  measuredRef.current = true;
                  setRowHeight(h);
                }
              } else if (prevH !== h) {
                setRowHeight(h); // 같은 행이 실제로 커지거나 줄었다(밀도·폭 변경)
              }
            }
            schedule(); // 위쪽 레이아웃이 바뀌었을 수 있으니 offsetTop 도 다시 잰다
          });
    const ensureObserved = () => {
      if (!ro) return;
      if (observed && observed.isConnected && anchor.contains(observed)) return;
      if (observed) ro.unobserve(observed);
      observed = firstRealRow(anchor);
      observedH = -1;
      if (observed) ro.observe(observed);
    };

    let frame = 0;
    const update = () => {
      frame = 0;
      ensureObserved();
      const next = readMetrics(anchor, parent);
      setMetrics((prev) =>
        prev.scrollTop === next.scrollTop && prev.viewportHeight === next.viewportHeight && prev.offsetTop === next.offsetTop
          ? prev
          : next,
      );
    };
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    schedule(); // 첫 측정도 rAF 콜백에서
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro?.disconnect();
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [enabled, anchorRef, total]);

  if (!enabled) return { start: 0, end: total, topPad: 0, bottomPad: 0, rowHeight };
  return { ...windowRange({ ...metrics, rowHeight, total }), rowHeight };
}

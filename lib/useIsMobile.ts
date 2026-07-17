"use client";

import { useEffect, useState } from "react";

/**
 * 뷰포트가 모바일 폭(기본 ≤768px)인지 여부.
 * SSR/하이드레이션 안전: 서버·초기 렌더는 false(데스크톱)로 시작하고,
 * 마운트 후 matchMedia 로 보정한다(불일치 아닌 후속 상태 변경).
 * 앱의 CSS @media(max-width:768px) 브레이크포인트와 동일하게 맞춤.
 */
export function useIsMobile(breakpoint = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width:${breakpoint}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [breakpoint]);
  return isMobile;
}

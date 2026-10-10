"use client";

import { useEffect } from "react";
import { navTargetForEvent } from "@/lib/sites/shellPath";

/* iframe 안 페이지가 이동하면(/pub 가 붙인 __ts/nav.js 가 postMessage) 셸 주소창을
   /s/<slug>/<예쁜 경로>#hash 로 맞춘다 — 그대로 복사해 공유할 수 있게.
   - 우리 iframe(source)·샌드박스 origin("null")·메시지 모양을 확인한 것만 받는다(lib/sites/shellPath).
   - 하는 일은 같은 사이트 경로로의 replaceState 뿐이다. 최상위 창을 이동시키지 않는다.
   - 처음 열 때 주소에 #hash 가 있으면(서버는 해시를 못 받는다) iframe 에 붙여 그 위치로 보낸다. */
export default function SiteAddressSync({ slug, frameId }: { slug: string; frameId: string }) {
  useEffect(() => {
    const frame = document.getElementById(frameId);
    if (!(frame instanceof HTMLIFrameElement)) return;

    const hash = window.location.hash;
    if (hash && frame.src && !frame.src.includes("#")) frame.src = frame.src + hash;

    const onMessage = (ev: MessageEvent) => {
      const target = navTargetForEvent(ev, frame.contentWindow, slug);
      if (!target) return;
      if (target === window.location.pathname + window.location.hash) return;
      window.history.replaceState(null, "", target);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [slug, frameId]);
  return null;
}

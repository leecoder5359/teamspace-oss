import { cache } from "react";
import { getPageContext } from "@/lib/workspace";
import { loadAccess } from "@/lib/pageGuard";

/* =====================================================================
   서버 렌더 전용 — (ws) 레이아웃과 페이지가 같은 요청 안에서 컨텍스트·접근 색인을 한 번만 만든다.

   한 화면을 열면 레이아웃(사이드바)과 페이지(게이트)가 각자 getPageContext → loadAccess 를 불러
   멤버십 조회와 워크스페이스 전체 스캔이 두 번씩 돌았다. React `cache` 는 **요청 하나의 렌더 동안만**
   기억한다(요청 사이에는 공유하지 않는다).

   API 라우트에서는 쓰지 말 것 — pageGuard.loadAccess 위 주석대로, 라우트의 '검사→변경→재검사'
   흐름에 요청 캐시를 두면 낡은 판정이 돌아온다. 렌더는 변경을 하지 않으므로 이 함정이 없다.
   ===================================================================== */

/** 렌더 한 번당 한 번 — 비멤버는 /login 으로 보낸다(getPageContext 와 같다). */
export const getRenderContext = cache(() => getPageContext());

/** 렌더 한 번당 한 번 — getRenderContext 의 컨텍스트로 만든 접근 색인. */
export const getRenderAccess = cache(async () => loadAccess(await getRenderContext()));

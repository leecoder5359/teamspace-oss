import type { MetadataRoute } from "next";

/* =====================================================================
   PWA 매니페스트 (격차 F1).

   설치형 앱으로 쓸 수 있어야 폰에서 실제로 열어 본다 — 브라우저 탭 하나로만
   존재하면 "노트북 앞에 있을 때만 쓰는 도구" 가 된다.

   `display: standalone` 이지만 시작 화면은 `/dashboard` 다. 루트(`/`)는 첫
   페이지로 리다이렉트하는 경유지라, 설치 아이콘을 눌렀을 때 남의 문서로
   들어가는 것보다 대시보드가 낫다.
   ===================================================================== */

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TeamSpace — 팀 지식·작업 워크스페이스",
    short_name: "TeamSpace",
    description: "문서·보드·결정을 한곳에서. 에이전트와 사람이 같은 워크스페이스를 쓴다.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0F1420",
    theme_color: "#2F62FF",
    lang: "ko",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // maskable: 안드로이드가 원형·스쿼클로 잘라내도 마크가 살아 있어야 한다.
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "검색", url: "/search" },
      { name: "문서", url: "/docs" },
      { name: "알림", url: "/inbox" },
    ],
  };
}

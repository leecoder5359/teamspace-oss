"use client";

import dynamic from "next/dynamic";

// BlockNote는 window를 쓰므로 클라이언트 전용 로드 (SSR 비활성)
const PageEditor = dynamic(() => import("./PageEditor"), { ssr: false });
// 파일 기반 마크다운 에디터 (kind="doc" 페이지 전용)
const RawDocEditor = dynamic(() => import("./RawDocEditor"), { ssr: false });

export default function PageView({ pageId, fileBacked }: { pageId: string; fileBacked?: boolean }) {
  // key로 페이지 전환 시 에디터를 리마운트 → 상태 초기화를 effect 동기 setState 없이 처리
  if (fileBacked) return <RawDocEditor key={pageId} pageId={pageId} />;
  return <PageEditor key={pageId} pageId={pageId} />;
}

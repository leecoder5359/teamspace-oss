"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useSyncExternalStore } from "react";

// BlockNote·에디터 모두 window 를 쓰므로 클라이언트 전용 로드 (SSR 비활성).
// 로더를 밖으로 빼 아래 '미리 받기' 와 같은 import() 를 쓴다 — dynamic() 안에 import() 를 직접 쓰면 번들러가
// 그 호출을 별도 모듈 그래프로 묶어, 밖의 import() 와 다른 청크(편집기 코드 중복 다운로드·두 번 평가)가 된다.
// 서버 번들에서는 import() 자체를 지운다(typeof window 는 빌드 때 상수로 접힌다) — ssr:false 라 서버는 로더를
// 부르지 않는데, 남겨 두면 BlockNote 가 서버 청크로 통째로 컴파일된다(dynamic() 안의 import() 는 Next 가 대신 지워 줬다).
const noEditor = () => Promise.resolve({ default: () => null });
const loadPageEditor = typeof window === "undefined" ? noEditor : () => import("./PageEditor");
const loadRawDocEditor = typeof window === "undefined" ? noEditor : () => import("./RawDocEditor");
const PageEditor = dynamic(() => loadPageEditor(), { ssr: false });
const RawDocEditor = dynamic(() => loadRawDocEditor(), { ssr: false });
import SharePanel from "./ws/SharePanel";
import PresenceBar from "./ws/PresenceBar";
import Breadcrumb from "./Breadcrumb";
import DocToc from "./DocToc";
import type { PagePrefetch } from "@/lib/pagePrefetch";

/* =====================================================================
   문서 편집 진입점.

   격차조사 A1 이전엔 kind="doc" 이 전부 RawDocEditor(textarea)로 갔고
   BlockNote 분기는 도달 불가였다. 이제 반대다 — 기본이 블록 편집기고,
   원문 모드는 안전밸브로 남긴다.

   원문 모드를 남기는 이유: 마크다운↔블록 변환은 lib/md 가 왕복 고정점을
   테스트로 보장하지만, 그래도 편집기가 손대지 못하는 표기를 사람이 직접
   고쳐야 하는 순간이 온다(옵시디언의 소스 모드와 같은 역할). 선택은
   문서별이 아니라 사용자별이라 localStorage 에 둔다.
   ===================================================================== */

type Mode = "rich" | "source";
const MODE_KEY = "ws:editorMode";

/* localStorage 를 외부 스토어로 다룬다 — effect 안에서 setState 하면
   첫 페인트에 모드가 한 번 튀고(rich→source) 린트도 막는다. */
const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}
function getSnapshot(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "source" ? "source" : "rich";
  } catch {
    return "rich";
  }
}
// 서버에서는 항상 rich — 클라이언트가 source 면 하이드레이션 직후 교체된다
const getServerSnapshot = (): Mode => "rich";

/* 편집기 청크를 하이드레이션 전에 받기 시작한다.
   ssr:false 인 dynamic 은 서버가 청크 preload 를 싣지 않고(PreloadChunks 는 ssr:true 경로만), 클라에서도
   서버가 비워 둔 경계를 하이드레이션이 끝난 뒤에야 다시 그리면서 import() 를 부른다 — 그동안 페이지 전체
   하이드레이션 시간만큼 편집기(BlockNote) 다운로드가 늦게 시작됐다. 이 모듈은 /p/<id> 의 RSC 페이로드를
   풀 때 평가되므로 여기서 같은 로더를 먼저 불러 둔다(나중의 dynamic 로더는 이미 받은 모듈을 그대로 쓴다).
   지금 모드의 편집기만 — 원문 모드 사용자는 BlockNote 를 받지 않는다. */
if (typeof window !== "undefined") {
  void (getSnapshot() === "source" ? loadRawDocEditor() : loadPageEditor()).catch(() => {
    /* 실패해도 dynamic 로더가 렌더 때 다시 시도한다 */
  });
}

export default function PageView({
  pageId,
  fileBacked,
  initial = null,
}: {
  pageId: string;
  fileBacked?: boolean;
  /** 서버가 미리 읽은 본문 — 편집기가 첫 마운트에 한 번만 쓴다(모드 전환 뒤엔 API 로 다시 받는다). */
  initial?: PagePrefetch | null;
}) {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // 목차(U5)가 헤딩을 모을 본문 영역 — 편집기·원문 어느 모드든 이 안에 그려진다
  const bodyRef = useRef<HTMLDivElement>(null);

  const pick = useCallback((m: Mode) => {
    try {
      window.localStorage.setItem(MODE_KEY, m);
    } catch {
      /* 시크릿 모드 등에서 실패해도 편집은 계속돼야 한다 */
    }
    listeners.forEach((cb) => cb());
  }, []);

  // 파일 기반이 아닌 페이지(레거시)는 종전대로 블록 편집기만
  if (!fileBacked)
    return (
      <div className="ws-page-view">
        <Breadcrumb pageId={pageId} />
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div ref={bodyRef} style={{ flex: 1, minWidth: 0 }}>
            <PageEditor key={pageId} pageId={pageId} initial={initial} />
            <div className="ws-share-panel">
              <SharePanel pageId={pageId} />
            </div>
          </div>
          <DocToc rootRef={bodyRef} />
        </div>
      </div>
    );

  return (
    <div className="ws-page-view">
      <Breadcrumb pageId={pageId} />
      <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
        {/* 프레즌스(격차 D4) — 편집기 모드면 '편집 중'으로 알린다 */}
        <PresenceBar pageId={pageId} editing={mode === "rich" || mode === "source"} />
        <span style={{ flex: 1 }} />
        <button
          className="ws-btn-soft"
          aria-pressed={mode === "rich"}
          onClick={() => pick("rich")}
          style={mode === "rich" ? { background: "var(--text-strong)", color: "var(--surface-card)", borderColor: "var(--text-strong)" } : undefined}
        >
          편집기
        </button>
        <button
          className="ws-btn-soft"
          aria-pressed={mode === "source"}
          onClick={() => pick("source")}
          style={mode === "source" ? { background: "var(--text-strong)", color: "var(--surface-card)", borderColor: "var(--text-strong)" } : undefined}
        >
          원문
        </button>
      </div>
      <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <div ref={bodyRef} style={{ flex: 1, minWidth: 0 }}>
          {mode === "rich" ? <PageEditor key={pageId} pageId={pageId} initial={initial} /> : <RawDocEditor key={pageId} pageId={pageId} initial={initial} />}
          {/* 공유 범위(격차 D3) — 편집기·원문 어느 모드에서도 보여야 한다 */}
          <div className="ws-share-panel">
            <SharePanel pageId={pageId} />
          </div>
        </div>
        <DocToc rootRef={bodyRef} />
      </div>
    </div>
  );
}

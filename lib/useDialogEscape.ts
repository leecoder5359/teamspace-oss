"use client";

import { useEffect, useRef } from "react";

/**
 * 다이얼로그·드로어 공통 키보드 처리. open 인 동안
 * - Escape 로 onClose 를 부른다(document keydown — TaskDetail 에서 쓰던 방식),
 * - 돌려준 ref 를 붙인 요소(보통 닫기 버튼)에 포커스를 옮기고,
 * - 닫히면 열기 전에 포커스가 있던 요소로 되돌린다(DOM 에 남아 있을 때만).
 * onClose 는 최신 것을 쓰므로 매 렌더 새 함수를 넘겨도 리스너를 다시 달지 않는다.
 */
export function useDialogEscape<T extends HTMLElement = HTMLButtonElement>(open: boolean, onClose: () => void) {
  const focusRef = useRef<T | null>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (prev && prev.isConnected) prev.focus();
    };
  }, [open]);

  return focusRef;
}

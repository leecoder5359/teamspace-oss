"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { buildTocFromDom, type TocItem } from "@/lib/md/headings";
import { useIsMobile } from "@/lib/useIsMobile";

/* =====================================================================
   문서 오른쪽 목차.

   마크다운이 아니라 **렌더된 DOM** 에서 h1~h3 를 모은다 — 미리보기
   (MarkdownPreview)와 블록 편집기(BlockNote) 어느 쪽이든 헤딩은 h1~h3
   요소라 같은 컴포넌트 하나로 둘 다 덮는다. 편집 중 바뀌는 헤딩은
   MutationObserver(200ms 디바운스)로 따라간다.
   ===================================================================== */

const SELECTOR = "h1,h2,h3";

/** 헤딩 글자 — 미리보기가 끝에 붙이는 '#' 앵커는 뺀다. */
function headingText(el: HTMLElement): string {
  const full = el.textContent ?? "";
  const anchor = el.querySelector(".ws-heading-anchor");
  const tail = anchor?.textContent ?? "";
  return anchor && full.endsWith(tail) ? full.slice(0, full.length - tail.length) : full;
}

/**
 * 편집기 안 헤딩엔 id 를 쓰지 않는다 — ProseMirror 가 관리하는 DOM 이라 속성 변경이 DOM 변경 읽기를 일으키고
 * 다시 그릴 때 속성이 사라질 수 있다. 대신 `#해시` 는 아래 scrollToHash 가 목차 항목 → 요소 매핑으로 직접 처리한다.
 */
const isEditable = (el: HTMLElement) => !!el.closest('[contenteditable="true"]');

export default function DocToc({ rootRef, minHeadings = 3 }: { rootRef: RefObject<HTMLElement | null>; minHeadings?: number }) {
  // 1024px 미만에선 숨긴다(본문 폭이 먼저)
  const narrow = useIsMobile(1023);
  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState<string | null>(null);
  // 목차 항목 → 실제 요소(편집기 헤딩은 id 가 없어 요소로 찾는다)
  const elsRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    if (narrow) return;
    const root = rootRef.current;
    if (!root) return;

    const itemsRef = { current: [] as TocItem[] };
    const pickActive = () => {
      const els = elsRef.current;
      const line = window.innerHeight / 3;
      let cur: string | null = null;
      els.forEach((el, i) => {
        if (el.getBoundingClientRect().top <= line) cur = itemsRef.current[i]?.id ?? cur;
      });
      setActive(cur ?? itemsRef.current[0]?.id ?? null);
    };

    const collect = () => {
      // 임베드 카드(data-toc-skip) 안의 헤딩은 다른 문서의 것 — 목차·활성 판정에서 뺀다
      const els = Array.from(root.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => !el.closest("[data-toc-skip]"));
      const toc = buildTocFromDom(els.map((el) => ({ level: Number(el.tagName[1]), text: headingText(el), id: el.id || null })));
      els.forEach((el, i) => {
        if (!el.id && !isEditable(el)) el.id = toc[i].id;
      });
      elsRef.current = els;
      itemsRef.current = toc;
      setItems((prev) => (sameToc(prev, toc) ? prev : toc));
      pickActive();
      scrollToHash();
    };

    // 새로고침·공유 링크의 `#해시` — 편집기 헤딩은 id 가 없어 브라우저가 못 찾으니 목차 매핑으로 스크롤한다.
    // 미리보기(id 가 있는 쪽)는 브라우저 기본 동작에 맡긴다.
    let hashDone = false;
    const scrollToHash = (force = false) => {
      if (hashDone && !force) return;
      let want = window.location.hash.slice(1);
      if (!want) return;
      try {
        want = decodeURIComponent(want);
      } catch {
        /* 깨진 퍼센트 인코딩은 원문 그대로 */
      }
      const i = itemsRef.current.findIndex((it) => it.id === want);
      if (i < 0) return;
      hashDone = true;
      const el = elsRef.current[i];
      if (el && !el.id) el.scrollIntoView({ block: "start" });
      setActive(want);
    };
    const onHash = () => scrollToHash(true);
    window.addEventListener("hashchange", onHash);

    // 첫 수집도 타이머로 — effect 본문에서 동기 setState 하지 않는다
    let debounce: ReturnType<typeof setTimeout> | null = setTimeout(collect, 0);
    const mo = new MutationObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(collect, 200);
    });
    // attributes 는 보지 않는다 — 위에서 id 를 쓰는 것이 다시 수집을 부르지 않게
    mo.observe(root, { childList: true, subtree: true, characterData: true });

    // 스크롤 컨테이너가 window 가 아닐 수 있다 — 캡처 단계로 모든 스크롤을 받는다
    let last = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      const now = Date.now();
      if (now - last >= 100) {
        last = now;
        pickActive();
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          last = Date.now();
          pickActive();
        }, 100 - (now - last));
      }
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });

    return () => {
      mo.disconnect();
      window.removeEventListener("hashchange", onHash);
      if (debounce) clearTimeout(debounce);
      if (trailing) clearTimeout(trailing);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [narrow, rootRef]);

  if (narrow || items.length < minHeadings) return null;

  return (
    <nav aria-label="목차" className="ws-doc-toc">
      <ol>
        {items.map((it, i) => (
          <li key={`${it.id}-${i}`} className={`ws-toc-l${it.level}`}>
            <a
              href={`#${it.id}`}
              aria-current={active === it.id ? "true" : undefined}
              onClick={(e) => {
                e.preventDefault();
                const el = elsRef.current[i] ?? document.getElementById(it.id);
                el?.scrollIntoView({ block: "start" });
                history.replaceState(null, "", `#${it.id}`);
                setActive(it.id);
              }}
            >
              {it.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function sameToc(a: TocItem[], b: TocItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.id === b[i].id && x.text === b[i].text && x.level === b[i].level);
}

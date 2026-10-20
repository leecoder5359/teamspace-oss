"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../ws/icons";
import { Dot } from "../ws/ui";

/* ===== 칸반 카드 메뉴 (U-31) =====
   드래그는 터치·키보드로 못 하므로 카드마다 "상태 변경" 메뉴를 둔다. 고른 칸은 onPick 으로 넘기고
   화면이 드래그 놓기와 같은 onMove 로 옮긴다(낙관적 갱신 + 실패 시 되돌림·배너).
   메뉴 모양은 TaskDetail 의 role="menu"(.ws-menu-wrap·.ws-menu·.ws-menuitem)를 따르고,
   Escape·바깥 클릭으로 닫으며 닫으면 트리거로 포커스를 돌려준다.
   카드 자체가 눌러서 여는 요소라 클릭이 카드로 번지지 않게 여기서 막는다
   (키는 카드 쪽이 자기 자신에서 난 Enter/Space 만 받으므로 막지 않는다). */
/** 메뉴를 잘라 낼 수 있는 가장 가까운 조상(overflow 가 visible 이 아닌 요소 — .ws-kanban 은 overflow-x 때문에 세로도 잘린다)과
    화면을 합친 세로 범위. */
function clipBounds(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    if (window.getComputedStyle(node).overflowY === "visible") continue;
    const r = node.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
    break;
  }
  return { top, bottom };
}

export type KanbanColumnOption = { key: string; label: string; color?: string };

export default function KanbanCardMenu({
  cardTitle,
  options,
  current,
  onPick,
}: {
  cardTitle: string;
  options: KanbanColumnOption[];
  /** 지금 카드가 있는 칸의 키("" = 미지정) */
  current: string;
  onPick: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  // 아래로 열면 잘릴 때만 위로 연다. 그리기 전에 재서 깜빡이지 않게 layout effect 에서 정한다.
  const [up, setUp] = useState(false);
  // 열 때 포커스할 항목(현재 칸). 열린 동안 부모가 다시 그려져도 포커스를 되돌리지 않게 여는 순간에만 정한다.
  const startAt = useRef(0);

  useLayoutEffect(() => {
    if (!open || !menuRef.current || !triggerRef.current) return;
    const menu = menuRef.current.getBoundingClientRect();
    const trigger = triggerRef.current.getBoundingClientRect();
    const clip = clipBounds(menuRef.current);
    setUp(menu.bottom > clip.bottom && trigger.top - menu.height - 4 >= clip.top);
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    setUp(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    itemRefs.current[startAt.current]?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => {
      e.preventDefault();
      items[(n + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") {
      // 카드를 품은 드로어·다이얼로그의 Escape 까지 닫히지 않게
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") close(false);
  };

  const pick = (key: string) => {
    close(true);
    if (key !== current) onPick(key);
  };

  return (
    <div
      className="ws-menu-wrap"
      ref={wrapRef}
      onClick={(e) => e.stopPropagation()}
      draggable
      onDragStart={(e) => {
        // 메뉴 버튼을 끌어도 카드 드래그가 시작되지 않게
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="ws-icon-btn"
        // 카드 머리줄(칩 높이)을 키우지 않게 30px 버튼의 여백을 안쪽으로 당긴다
        style={{ margin: "-5px -6px -5px 0" }}
        aria-label={`카드 메뉴: ${cardTitle}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          startAt.current = Math.max(0, options.findIndex((o) => o.key === current));
          setOpen((o) => !o);
        }}
      >
        <Icon name="dots" size={15} />
      </button>
      {open && (
        <div
          ref={menuRef}
          className="ws-menu"
          role="menu"
          aria-label="상태 변경"
          data-placement={up ? "up" : "down"}
          onKeyDown={onMenuKey}
          style={{ left: "auto", right: 0, ...(up ? { top: "auto", bottom: "calc(100% + 4px)" } : null) }}
        >
          <div aria-hidden style={{ padding: "4px 9px 6px", fontSize: "var(--ds-fs-xs)", fontWeight: 700, color: "var(--text-muted)" }}>
            상태 변경
          </div>
          {options.map((o, i) => (
            <button
              key={o.key || "none"}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={o.key === current}
              tabIndex={-1}
              className="ws-menuitem"
              onClick={() => pick(o.key)}
            >
              <Dot color={o.color ?? "gray"} size={6} />
              {o.label}
              {o.key === current && <Icon name="check" size={13} style={{ marginLeft: "auto" }} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

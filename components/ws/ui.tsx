"use client";

import type { CSSProperties } from "react";
import { Icon } from "./icons";

/**
 * Saebit 공유 프리미티브 (디자인 소스 app/ui.jsx 포팅).
 * Avatar, AvatarStack, StatusPill, PriorityTag, SeverityBadge, LabelChip,
 * DDay, ProgressBar, IdChip, Dot + 헬퍼(pillStyle, ddayInfo, fmtDateK, fmtTime).
 */

export type SelectColor = string;

// 옵션 color 키 → 실제 색상. (DatabaseView 와 공유)
export const SELECT_COLORS: Record<string, string> = {
  gray: "#8a8f98",
  blue: "#4c8bf5",
  green: "#3aa675",
  yellow: "#e0a106",
  red: "#e5484d",
  purple: "#8e63d6",
  orange: "#e08c3a",
  pink: "#d6609b",
  teal: "#2aa39a",
};

export function colorFor(key: string | undefined | null): string {
  if (!key) return SELECT_COLORS.gray;
  return SELECT_COLORS[key] ?? key; // 알 수 없는 키는 그대로 색상값으로 취급
}

export type PillMode = "soft" | "solid" | "bar";

/** 옵션 색상 + 모드에 따른 인라인 스타일 */
export function pillStyle(key: string | undefined | null, mode: PillMode = "soft"): CSSProperties {
  const c = colorFor(key);
  if (mode === "solid") {
    return { background: c, color: "#fff", borderColor: "transparent" };
  }
  if (mode === "bar") {
    return {
      background: "transparent",
      color: "var(--ds-text)",
      borderColor: "var(--ds-border)",
      boxShadow: `inset 3px 0 0 ${c}`,
    };
  }
  // soft (default)
  return {
    background: `color-mix(in srgb, ${c} 16%, transparent)`,
    color: `color-mix(in srgb, ${c} 72%, var(--ds-text))`,
    borderColor: `color-mix(in srgb, ${c} 30%, transparent)`,
  };
}

/* ---------- 이름 → 이니셜 / 색상 ---------- */
const AVATAR_PALETTE = ["blue", "green", "purple", "orange", "pink", "teal", "red", "yellow"];

export function initials(name: string): string {
  const n = name.trim();
  if (!n) return "?";
  // 한글이면 마지막 1~2글자, 영문이면 단어 첫 글자들
  if (/[가-힣]/.test(n)) return n.slice(-2);
  const words = n.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return n.slice(0, 2).toUpperCase();
}

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return colorFor(AVATAR_PALETTE[h % AVATAR_PALETTE.length]);
}

/* ---------- 날짜 헬퍼 ---------- */
function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateK(value: unknown): string {
  const d = parseDate(value);
  if (!d) return "";
  return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

export function fmtTime(value: unknown): string {
  const d = parseDate(value);
  if (!d) return "";
  return d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

export type DDayTone = "over" | "today" | "soon" | "far" | "none";

export function ddayInfo(value: unknown): { label: string; tone: DDayTone; date: Date | null } {
  const d = parseDate(value);
  if (!d) return { label: "", tone: "none", date: null };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(d);
  target.setHours(0, 0, 0, 0);
  const diff = Math.round((target.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return { label: "D-DAY", tone: "today", date: d };
  if (diff < 0) return { label: `D+${-diff}`, tone: "over", date: d };
  return { label: `D-${diff}`, tone: diff <= 3 ? "soon" : "far", date: d };
}

/* ============ 프리미티브 ============ */

export function Dot({ color, size = 8 }: { color?: string | null; size?: number }) {
  return (
    <span
      className="ds-dot"
      style={{ background: colorFor(color), width: size, height: size }}
    />
  );
}

export function Avatar({
  name,
  size = 24,
}: {
  name: string;
  size?: number;
}) {
  const label = name.trim() || "미지정";
  return (
    <span
      className="ds-avatar"
      title={label}
      style={{
        width: size,
        height: size,
        background: name.trim() ? avatarColor(label) : "var(--ds-surface-3)",
        fontSize: Math.round(size * 0.4),
        color: name.trim() ? "#fff" : "var(--ds-text-3)",
      }}
    >
      {name.trim() ? initials(label) : "?"}
    </span>
  );
}

export function AvatarStack({ names, size = 24, max = 3 }: { names: string[]; size?: number; max?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="ds-avatar-stack">
      {shown.map((n, i) => (
        <span key={i} style={{ marginLeft: i === 0 ? 0 : -size * 0.32, zIndex: shown.length - i }}>
          <Avatar name={n} size={size} />
        </span>
      ))}
      {extra > 0 && (
        <span
          className="ds-avatar"
          style={{ width: size, height: size, marginLeft: -size * 0.32, fontSize: Math.round(size * 0.36), background: "var(--ds-surface-3)", color: "var(--ds-text-2)" }}
        >
          +{extra}
        </span>
      )}
    </span>
  );
}

export function StatusPill({ label, color, mode = "soft" }: { label: string; color?: string | null; mode?: PillMode }) {
  return (
    <span className="ds-pill ds-status-pill" style={pillStyle(color, mode)}>
      <Dot color={color} size={6} />
      {label}
    </span>
  );
}

export function PriorityTag({ label, color }: { label: string; color?: string | null }) {
  return (
    <span className="ds-pill ds-priority-tag" style={pillStyle(color, "soft")}>
      <Icon name="flag" size={12} />
      {label}
    </span>
  );
}

export function SeverityBadge({ label, color }: { label: string; color?: string | null }) {
  return (
    <span className="ds-pill ds-severity" style={pillStyle(color ?? "red", "soft")}>
      <Icon name="alert" size={12} />
      {label}
    </span>
  );
}

export function LabelChip({ label, color }: { label: string; color?: string | null }) {
  return (
    <span className="ds-pill ds-label-chip" style={pillStyle(color, "soft")}>
      {label}
    </span>
  );
}

export function DDay({ value }: { value: unknown }) {
  const info = ddayInfo(value);
  if (!info.date) return <span className="ds-dday ds-dday-none">—</span>;
  return (
    <span className={`ds-dday ds-dday-${info.tone}`} title={fmtDateK(value)}>
      <Icon name="calendar" size={12} />
      <span className="ds-dday-date">{fmtDateK(value)}</span>
      <span className="ds-dday-tag">{info.label}</span>
    </span>
  );
}

export function ProgressBar({ value, showLabel = true }: { value: number; showLabel?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const tone = pct >= 100 ? "done" : pct >= 50 ? "mid" : "low";
  return (
    <span className="ds-progress">
      <span className="ds-progress-track">
        <span className={`ds-progress-fill ds-progress-${tone}`} style={{ width: `${pct}%` }} />
      </span>
      {showLabel && <span className="ds-progress-label">{pct}%</span>}
    </span>
  );
}

export function IdChip({ id }: { id: string }) {
  return <span className="ds-idchip">{id}</span>;
}

/** UUID/긴 id 를 짧은 표시용 코드로. (예: TASK-3F2A) */
export function shortId(id: string, prefix = "TSK"): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, "");
  return `${prefix}-${clean.slice(-4).toUpperCase()}`;
}

/*
 * 입력·버튼 스타일 상수 (U-21) — 화면마다 복제되던 값을 한곳에 모았다.
 * 값이 다른 변형은 이름으로 구분한다. 화면에 따라 다르게 보이던 값을 하나로 합치지는 않았다(시각 변화 0).
 */
/** 폭을 정하지 않는 입력(가로 배치용). */
export const inputBase: CSSProperties = {
  padding: "9px 12px", borderRadius: 9, border: "1px solid var(--border-default)",
  background: "var(--surface-card)", color: "var(--text-strong)", fontSize: "var(--ds-fs-md)", fontFamily: "inherit",
};
/** 한 줄을 다 쓰는 입력 — 폼의 기본. */
export const inputStyle: CSSProperties = { width: "100%", ...inputBase };
/** 사이트 화면의 입력 — 글자 16px. */
export const inputStyleLg: CSSProperties = { ...inputStyle, fontSize: "var(--ds-fs-lg)" };

export const primaryBtn: CSSProperties = {
  padding: "9px 16px", borderRadius: 9, fontSize: "var(--ds-fs-md)", fontWeight: 600, cursor: "pointer",
  border: "1px solid transparent", background: "var(--color-primary)", color: "#fff",
};
/** 좁은 칸에서 줄바꿈하지 않는 기본 버튼. */
export const primaryBtnNowrap: CSSProperties = { ...primaryBtn, whiteSpace: "nowrap" };
/** 아이콘을 앞에 붙이는 기본 버튼(인라인 플렉스). */
export const primaryBtnInline: CSSProperties = { ...primaryBtn, display: "inline-flex", alignItems: "center", gap: 5, whiteSpace: "nowrap" };

export const ghostBtn: CSSProperties = {
  padding: "6px 14px", borderRadius: "var(--ds-r-sm)", fontSize: 12.5, fontWeight: 600, cursor: "pointer",
  border: "1px solid var(--border-default)", background: "var(--surface-card)", color: "var(--text-strong)", whiteSpace: "nowrap",
};

/** 툴바·행 안의 작은 select. */
export const selectStyle: CSSProperties = {
  height: 32,
  padding: "0 8px",
  border: "1px solid var(--border-default)",
  borderRadius: 9,
  background: "var(--surface-card)",
  color: "var(--text-body)",
  fontSize: 12.5,
  fontFamily: "inherit",
  fontWeight: 600,
};

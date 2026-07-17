"use client";

import type { ReactNode } from "react";
import { Icon } from "./ws/icons";

/** [[제목]] → href 해석기. null이면 미해결(링크 없음). */
export type LinkResolver = (title: string) => string | null;

/* ---------- 마크다운 인라인 렌더 ---------- */
function docInline(text: string, resolveLink?: LinkResolver): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/g)
    .filter(Boolean)
    .map((p, i) => {
      if (p.startsWith("[[") && p.endsWith("]]")) {
        const inner = p.slice(2, -2);
        const [titlePart, displayPart] = inner.split("|");
        const title = titlePart.trim();
        const label = (displayPart ?? titlePart).trim();
        const href = resolveLink?.(title) ?? null;
        if (href) {
          return (
            <a key={i} href={href} className="ws-wikilink" style={{ color: "var(--color-primary)", textDecoration: "none", fontWeight: 600 }}>
              {label}
            </a>
          );
        }
        return (
          <span key={i} title="연결된 문서 없음" style={{ color: "var(--text-muted)", borderBottom: "1px dashed var(--border-default)" }}>
            {label}
          </span>
        );
      }
      if (p.startsWith("**") && p.endsWith("**")) {
        return (
          <strong key={i} style={{ fontWeight: 700, color: "var(--text-strong)" }}>
            {p.slice(2, -2)}
          </strong>
        );
      }
      if (p.startsWith("`") && p.endsWith("`")) {
        return (
          <code
            key={i}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.88em",
              background: "var(--surface-sunken)",
              padding: "1px 5px",
              borderRadius: 5,
            }}
          >
            {p.slice(1, -1)}
          </code>
        );
      }
      return p;
    });
}

/* ---------- 표(GFM table) ---------- */
type Align = "left" | "center" | "right";
const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
// 구분선: 셀이 모두 -, :, 공백 으로만 구성 (예: |---|:--:|)
const isTableSeparator = (s: string) => isTableRow(s) && /^\s*\|[\s:|-]+\|\s*$/.test(s) && s.includes("-");

function splitCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function renderTable(rows: string[], keyBase: number, resolveLink?: LinkResolver): ReactNode {
  const header = splitCells(rows[0]);
  const aligns: Align[] = splitCells(rows[1]).map((s) => {
    const l = s.startsWith(":");
    const r = s.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
  const body = rows.slice(2).map(splitCells);
  const th = { padding: "7px 12px", borderBottom: "2px solid var(--border-default)", background: "var(--surface-sunken)", fontWeight: 700, color: "var(--text-strong)", whiteSpace: "nowrap" as const };
  const td = { padding: "7px 12px", borderBottom: "1px solid var(--border-subtle)", color: "var(--text-body)", verticalAlign: "top" as const };
  return (
    <div key={"tbl" + keyBase} style={{ overflowX: "auto", margin: "12px 0" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13, lineHeight: 1.5 }}>
        <thead>
          <tr>
            {header.map((h, ci) => (
              <th key={ci} style={{ ...th, textAlign: aligns[ci] ?? "left" }}>
                {docInline(h, resolveLink)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri}>
              {r.map((c, ci) => (
                <td key={ci} style={{ ...td, textAlign: aligns[ci] ?? "left" }}>
                  {docInline(c, resolveLink)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- 마크다운 블록 렌더 ---------- */
function renderDocMd(md: string, resolveLink?: LinkResolver): ReactNode[] {
  const lines = md.split("\n");
  const out: ReactNode[] = [];
  let list: ReactNode[] | null = null;
  let table: string[] | null = null; // 누적 표 원본 줄
  let code: string[] | null = null; // 누적 코드펜스 줄
  const flushList = () => {
    if (list) {
      out.push(
        <ul
          key={"u" + out.length}
          style={{ margin: "6px 0 12px", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 5 }}
        >
          {list}
        </ul>,
      );
      list = null;
    }
  };
  const flushTable = () => {
    if (table) {
      out.push(renderTable(table, out.length, resolveLink));
      table = null;
    }
  };
  const flush = () => {
    flushList();
    flushTable();
  };

  lines.forEach((ln, i) => {
    // 코드펜스(```): 열림~닫힘 사이 원본 보존
    if (code) {
      if (/^\s*```/.test(ln)) {
        out.push(
          <pre
            key={i}
            style={{ overflowX: "auto", margin: "10px 0", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "12px 14px" }}
          >
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.6, color: "var(--text-body)", whiteSpace: "pre" }}>
              {code.join("\n")}
            </code>
          </pre>,
        );
        code = null;
      } else {
        code.push(ln);
      }
      return;
    }
    if (/^\s*```/.test(ln)) {
      flush();
      code = [];
      return;
    }

    // 표: 진행 중이면 표 줄을 누적, 아니면 헤더+구분선 감지로 시작
    if (table) {
      if (isTableRow(ln)) {
        table.push(ln);
        return;
      }
      flushTable(); // 표 종료 — 현재 줄은 아래 일반 처리로 진행
    } else if (isTableRow(ln) && isTableSeparator(lines[i + 1] ?? "")) {
      flush();
      table = [ln];
      return;
    }

    if (ln.startsWith("###### ")) {
      flush();
      out.push(
        <h6 key={i} style={{ fontFamily: "var(--font-body)", fontSize: 12, fontWeight: 700, color: "var(--text-sub)", margin: "12px 0 4px", textTransform: "uppercase", letterSpacing: "0.03em" }}>
          {docInline(ln.slice(7), resolveLink)}
        </h6>,
      );
    } else if (ln.startsWith("##### ")) {
      flush();
      out.push(
        <h5 key={i} style={{ fontFamily: "var(--font-body)", fontSize: 12.5, fontWeight: 700, color: "var(--text-sub)", margin: "13px 0 5px" }}>
          {docInline(ln.slice(6), resolveLink)}
        </h5>,
      );
    } else if (ln.startsWith("#### ")) {
      flush();
      out.push(
        <h4 key={i} style={{ fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 700, color: "var(--text-strong)", margin: "14px 0 5px" }}>
          {docInline(ln.slice(5), resolveLink)}
        </h4>,
      );
    } else if (ln.startsWith("### ")) {
      flush();
      out.push(
        <h3
          key={i}
          style={{ fontFamily: "var(--font-body)", fontSize: 14, fontWeight: 700, color: "var(--text-strong)", margin: "16px 0 6px" }}
        >
          {ln.slice(4)}
        </h3>,
      );
    } else if (ln.startsWith("## ")) {
      flush();
      out.push(
        <h2
          key={i}
          style={{ fontFamily: "var(--font-body)", fontSize: 16, fontWeight: 700, color: "var(--text-strong)", margin: "20px 0 8px", letterSpacing: "-0.01em" }}
        >
          {ln.slice(3)}
        </h2>,
      );
    } else if (ln.startsWith("# ")) {
      flush();
      out.push(
        <h1
          key={i}
          style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: "var(--text-strong)", margin: "4px 0 12px", letterSpacing: "-0.02em" }}
        >
          {ln.slice(2)}
        </h1>,
      );
    } else if (ln.startsWith("> ")) {
      flush();
      out.push(
        <blockquote
          key={i}
          style={{ borderLeft: "3px solid var(--color-primary)", padding: "6px 0 6px 14px", margin: "8px 0", color: "var(--text-sub)", fontSize: 13.5, background: "var(--surface-sunken)", borderRadius: "0 8px 8px 0" }}
        >
          {docInline(ln.slice(2), resolveLink)}
        </blockquote>,
      );
    } else if (ln.trim() === "---") {
      flush();
      out.push(<hr key={i} style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "16px 0" }} />);
    } else if (/^- \[[ x]\] /.test(ln)) {
      const done = ln[3] === "x";
      (list = list || []).push(
        <li
          key={i}
          style={{ listStyle: "none", marginLeft: -20, display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13.5, color: done ? "var(--text-muted)" : "var(--text-body)", lineHeight: 1.55 }}
        >
          <span
            style={{ width: 16, height: 16, borderRadius: 4, flex: "0 0 auto", marginTop: 1, border: done ? "none" : "1.5px solid var(--border-default)", background: done ? "var(--color-success)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}
          >
            {done && <Icon name="check" size={11} />}
          </span>
          <span style={{ textDecoration: done ? "line-through" : "none" }}>{docInline(ln.slice(6), resolveLink)}</span>
        </li>,
      );
    } else if (/^\d+\.\s/.test(ln) || ln.startsWith("- ")) {
      (list = list || []).push(
        <li key={i} style={{ fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.6 }}>
          {docInline(ln.replace(/^(\d+\.|-)\s/, ""), resolveLink)}
        </li>,
      );
    } else if (ln.trim() === "") {
      flush();
    } else {
      flush();
      out.push(
        <p key={i} style={{ fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.7, margin: "6px 0" }}>
          {docInline(ln, resolveLink)}
        </p>,
      );
    }
  });

  flush();
  return out;
}

/* ---------- 공개 컴포넌트 ---------- */
export default function MarkdownPreview({ markdown, resolveLink }: { markdown: string; resolveLink?: LinkResolver }) {
  return (
    <div className="ws-doc-prose">
      {markdown.trim() ? renderDocMd(markdown, resolveLink) : <div className="ws-empty-hint">본문이 비어 있어요</div>}
    </div>
  );
}

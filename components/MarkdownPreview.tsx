"use client";

import type { ReactNode } from "react";
import { Icon } from "./ws/icons";
import { parseMarkdown } from "@/lib/md/parse";
import { headingIdMap } from "@/lib/md/headings";
import MermaidBlock from "./MermaidBlock";
import type { Align, Block, Inline, ListItem } from "@/lib/md/ast";

/* =====================================================================
   마크다운 읽기전용 렌더러.

   종전엔 이 파일이 줄 단위로 직접 React 를 뱉었고, 그래서 아는 문법이
   **굵게**·`코드`·[[위키링크]] 셋뿐이었다 — 이미지·표준링크·이탤릭·
   취소선이 전부 글자로 새어나왔다(격차조사 A2·A3·A6). h1~h3 는 인라인
   파싱을 아예 건너뛰어 헤딩 레벨에 따라 동작이 갈리기까지 했다(A4).

   이제 문법 해석은 lib/md/parse 가 전담하고 여기는 AST 를 그리기만 한다.
   같은 파서를 BlockNote 변환기도 쓰므로 "미리보기와 편집기가 다르게
   보이는" 부류의 버그가 구조적으로 생기지 않는다.
   ===================================================================== */

/** [[제목]] → href 해석기. null이면 미해결(링크 없음). */
export type LinkResolver = (title: string) => string | null;

export type MarkdownPreviewProps = {
  markdown: string;
  resolveLink?: LinkResolver;
  /** 미해결 [[제목]] 을 눌렀을 때 — 그 제목으로 문서를 만든다(B5). */
  onCreateLink?: (title: string) => void;
  /** #태그 클릭 — 태그 필터로 이동(B3). */
  onTagClick?: (tag: string) => void;
  /** ![[문서]] 임베드 렌더 위임(B2). 없으면 링크 카드로 대체. */
  renderEmbed?: (target: string) => ReactNode;
  /** 헤딩에 id·# 앵커를 붙일지(기본 true). 임베드 안의 미리보기는 false — 호스트 문서의 id 와 겹치지 않게. */
  headingIds?: boolean;
};

/* ---------- 링크 안전화 ---------- */

// javascript:·data: 스킴은 본문에서 클릭 가능한 링크가 되면 안 된다.
// 문서 본문은 에이전트도 쓰므로 신뢰 입력이 아니다.
const SAFE_SCHEME = /^(https?:|mailto:|tel:|#|\/|\.{1,2}\/)/i;
function safeHref(href: string): string {
  const t = href.trim();
  if (!t) return "";
  return SAFE_SCHEME.test(t) ? t : "";
}
const isExternal = (href: string) => /^https?:/i.test(href);

/* ---------- 인라인 ---------- */

type Ctx = Pick<MarkdownPreviewProps, "resolveLink" | "onCreateLink" | "onTagClick"> & {
  /** 헤딩 블록 → id. 문서 전체를 한 번에 계산해야 중복 제목이 -2, -3 을 받는다(lib/md/headings). */
  headingIds?: Map<Block, string>;
};

function renderInline(nodes: Inline[], ctx: Ctx, keyPrefix = ""): ReactNode[] {
  return nodes.map((n, i) => {
    const key = `${keyPrefix}${i}`;
    switch (n.t) {
      case "text":
        return <span key={key}>{n.v}</span>;

      case "strong":
        return (
          <strong key={key} style={{ fontWeight: 700, color: "var(--text-strong)" }}>
            {renderInline(n.c, ctx, key + "-")}
          </strong>
        );

      case "em":
        return <em key={key}>{renderInline(n.c, ctx, key + "-")}</em>;

      case "del":
        return (
          <del key={key} style={{ color: "var(--text-muted)" }}>
            {renderInline(n.c, ctx, key + "-")}
          </del>
        );

      case "mark":
        return (
          <mark key={key} style={{ background: "var(--color-primary-weak, #FDF0EC)", color: "inherit", padding: "0 3px", borderRadius: 4 }}>
            {renderInline(n.c, ctx, key + "-")}
          </mark>
        );

      case "code":
        return (
          <code
            key={key}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.88em",
              background: "var(--surface-sunken)",
              padding: "1px 5px",
              borderRadius: 5,
            }}
          >
            {n.v}
          </code>
        );

      case "link": {
        const href = safeHref(n.href);
        const ext = isExternal(href);
        return (
          <a
            key={key}
            href={href}
            {...(ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            style={{ color: "var(--color-primary)", textDecoration: "underline", textUnderlineOffset: 2 }}
          >
            {renderInline(n.c, ctx, key + "-")}
          </a>
        );
      }

      case "image":
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={key}
            src={safeHref(n.src)}
            alt={n.alt}
            style={{ maxWidth: "100%", height: "auto", borderRadius: 8, display: "block", margin: "8px 0" }}
          />
        );

      case "wikilink": {
        const href = ctx.resolveLink?.(n.target) ?? null;
        if (href) {
          return (
            <a key={key} href={href} className="ws-wikilink" style={{ color: "var(--color-primary)", textDecoration: "none", fontWeight: 600 }}>
              {n.label}
            </a>
          );
        }
        // 미해결 — 만들 수 있으면 버튼, 아니면 종전처럼 점선 표시
        if (ctx.onCreateLink) {
          return (
            <button
              key={key}
              type="button"
              title={`'${n.target}' 문서 만들기`}
              onClick={() => ctx.onCreateLink!(n.target)}
              style={{
                font: "inherit",
                background: "none",
                border: "none",
                padding: 0,
                cursor: "pointer",
                color: "var(--text-muted)",
                borderBottom: "1px dashed var(--border-default)",
              }}
            >
              {n.label}
            </button>
          );
        }
        return (
          <span key={key} title="연결된 문서 없음" style={{ color: "var(--text-muted)", borderBottom: "1px dashed var(--border-default)" }}>
            {n.label}
          </span>
        );
      }

      case "tag":
        return (
          <button
            key={key}
            type="button"
            data-tag={n.name}
            onClick={ctx.onTagClick ? () => ctx.onTagClick!(n.name) : undefined}
            style={{
              font: "inherit",
              fontSize: "0.86em",
              fontWeight: 600,
              background: "var(--surface-sunken)",
              color: "var(--text-sub)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 999,
              padding: "1px 8px",
              margin: "0 1px",
              cursor: ctx.onTagClick ? "pointer" : "default",
            }}
          >
            #{n.name}
          </button>
        );
    }
  });
}

/* ---------- 콜아웃 ---------- */

const CALLOUT_META: Record<string, { color: string; icon: Parameters<typeof Icon>[0]["name"]; label: string }> = {
  NOTE: { color: "var(--color-primary)", icon: "flag", label: "노트" },
  INFO: { color: "var(--color-primary)", icon: "flag", label: "정보" },
  TIP: { color: "#0CA678", icon: "check", label: "팁" },
  SUCCESS: { color: "#0CA678", icon: "check", label: "완료" },
  WARNING: { color: "#E0900F", icon: "flag", label: "주의" },
  CAUTION: { color: "#E0900F", icon: "flag", label: "주의" },
  DANGER: { color: "#D14343", icon: "flag", label: "위험" },
  ERROR: { color: "#D14343", icon: "flag", label: "오류" },
};
const calloutMeta = (kind: string) => CALLOUT_META[kind] ?? { color: "var(--text-sub)", icon: "flag" as const, label: kind };

/* ---------- 블록 ---------- */

function renderListItems(items: ListItem[], ctx: Ctx, keyPrefix: string): ReactNode[] {
  return items.map((item, i) => {
    const key = `${keyPrefix}${i}`;
    const isTask = item.checked !== null;
    return (
      <li
        key={key}
        style={
          isTask
            ? {
                listStyle: "none",
                marginLeft: -20,
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                fontSize: 13.5,
                color: item.checked ? "var(--text-muted)" : "var(--text-body)",
                lineHeight: 1.55,
              }
            : { fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.6 }
        }
      >
        {isTask && (
          <span
            aria-hidden
            style={{
              width: 16,
              height: 16,
              borderRadius: 4,
              flex: "0 0 auto",
              marginTop: 1,
              border: item.checked ? "none" : "1.5px solid var(--border-default)",
              background: item.checked ? "var(--color-success)" : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
            }}
          >
            {item.checked && <Icon name="check" size={11} />}
          </span>
        )}
        <span style={isTask ? { textDecoration: item.checked ? "line-through" : "none", flex: 1 } : undefined}>
          {renderInline(item.c, ctx, key + "-")}
          {/* 중첩 리스트 등 하위 블록 */}
          {item.children.length > 0 && <div style={{ marginTop: 4 }}>{renderBlocks(item.children, ctx, key + "c")}</div>}
        </span>
      </li>
    );
  });
}

const H_STYLE: Record<number, React.CSSProperties> = {
  1: { fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 700, color: "var(--text-strong)", margin: "4px 0 12px", letterSpacing: "-0.02em" },
  2: { fontFamily: "var(--font-body)", fontSize: 16, fontWeight: 700, color: "var(--text-strong)", margin: "20px 0 8px", letterSpacing: "-0.01em" },
  3: { fontFamily: "var(--font-body)", fontSize: 14, fontWeight: 700, color: "var(--text-strong)", margin: "16px 0 6px" },
  4: { fontFamily: "var(--font-body)", fontSize: 13, fontWeight: 700, color: "var(--text-strong)", margin: "14px 0 5px" },
  5: { fontFamily: "var(--font-body)", fontSize: 12.5, fontWeight: 700, color: "var(--text-sub)", margin: "13px 0 5px" },
  6: { fontFamily: "var(--font-body)", fontSize: 12, fontWeight: 700, color: "var(--text-sub)", margin: "12px 0 4px", textTransform: "uppercase", letterSpacing: "0.03em" },
};

const cellStyle = (a: Align): React.CSSProperties => ({ textAlign: a });

function renderBlocks(blocks: Block[], ctx: Ctx, keyPrefix = "", renderEmbed?: MarkdownPreviewProps["renderEmbed"]): ReactNode[] {
  return blocks.map((b, i) => {
    const key = `${keyPrefix}${i}`;
    switch (b.t) {
      case "heading": {
        const H = `h${b.level}` as "h1";
        const id = ctx.headingIds?.get(b);
        return (
          <H key={key} id={id} style={H_STYLE[b.level]}>
            {renderInline(b.c, ctx, key + "-")}
            {/* 앵커는 마지막 자식이어야 한다 — DocToc 이 헤딩 글자에서 끝의 '#' 을 떼어낸다 */}
            {id && (
              <a href={`#${id}`} className="ws-heading-anchor" aria-label="이 절 링크">
                #
              </a>
            )}
          </H>
        );
      }

      case "para":
        return (
          <p key={key} style={{ fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.7, margin: "6px 0" }}>
            {renderInline(b.c, ctx, key + "-")}
          </p>
        );

      case "quote":
        return (
          <blockquote
            key={key}
            style={{
              borderLeft: "3px solid var(--color-primary)",
              padding: "6px 0 6px 14px",
              margin: "8px 0",
              color: "var(--text-sub)",
              fontSize: 13.5,
              background: "var(--surface-sunken)",
              borderRadius: "0 8px 8px 0",
            }}
          >
            {renderBlocks(b.c, ctx, key + "-", renderEmbed)}
          </blockquote>
        );

      case "callout": {
        const meta = calloutMeta(b.kind);
        return (
          <div
            key={key}
            style={{
              border: `1px solid ${meta.color}`,
              borderLeft: `3px solid ${meta.color}`,
              borderRadius: "0 8px 8px 0",
              padding: "10px 14px",
              margin: "10px 0",
              background: "var(--surface-sunken)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: meta.color, fontWeight: 700, fontSize: 12.5, marginBottom: b.c.length ? 6 : 0 }}>
              <Icon name={meta.icon} size={13} />
              {b.title ? renderInline(b.title, ctx, key + "t") : meta.label}
            </div>
            {renderBlocks(b.c, ctx, key + "-", renderEmbed)}
          </div>
        );
      }

      case "code": {
        const pre = (
          <pre
            key={key}
            style={{ overflowX: "auto", margin: "10px 0", background: "var(--surface-sunken)", border: "1px solid var(--border-subtle)", borderRadius: 8, padding: "12px 14px" }}
          >
            <code
              data-lang={b.lang ?? undefined}
              style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, lineHeight: 1.6, color: "var(--text-body)", whiteSpace: "pre" }}
            >
              {b.v}
            </code>
          </pre>
        );
        // ```mermaid 는 다이어그램으로 — 로딩 중·실패 시엔 위 원문 블록을 그대로 보인다
        if (b.lang?.toLowerCase() === "mermaid") return <MermaidBlock key={key} code={b.v} fallback={pre} />;
        return pre;
      }

      case "table":
        return (
          <div key={key} className="ws-table-scroll" style={{ overflowX: "auto", margin: "10px 0" }}>
            <table className="ws-doc-table" style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  {b.head.map((c, ci) => (
                    <th
                      key={ci}
                      style={{
                        ...cellStyle(b.align[ci] ?? "left"),
                        borderBottom: "1.5px solid var(--border-default)",
                        padding: "7px 10px",
                        fontWeight: 700,
                        color: "var(--text-strong)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {renderInline(c.c, ctx, `${key}h${ci}-`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((c, ci) => (
                      <td
                        key={ci}
                        style={{
                          ...cellStyle(b.align[ci] ?? "left"),
                          borderBottom: "1px solid var(--border-subtle)",
                          padding: "7px 10px",
                          color: "var(--text-body)",
                          verticalAlign: "top",
                        }}
                      >
                        {renderInline(c.c, ctx, `${key}r${ri}c${ci}-`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );

      case "list": {
        const style: React.CSSProperties = { margin: "6px 0", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 2 };
        return b.ordered ? (
          <ol key={key} start={b.start} style={style}>
            {renderListItems(b.items, ctx, key + "-")}
          </ol>
        ) : (
          <ul key={key} style={style}>
            {renderListItems(b.items, ctx, key + "-")}
          </ul>
        );
      }

      case "hr":
        return <hr key={key} style={{ border: "none", borderTop: "1px solid var(--border-subtle)", margin: "16px 0" }} />;

      case "embed": {
        if (renderEmbed) return <div key={key}>{renderEmbed(b.target)}</div>;
        const href = ctx.resolveLink?.(b.target) ?? null;
        return (
          <div
            key={key}
            style={{ border: "1px solid var(--border-subtle)", borderRadius: 10, padding: "10px 14px", margin: "10px 0", background: "var(--surface-card)", fontSize: 13 }}
          >
            <span style={{ color: "var(--text-muted)", fontSize: 11.5, marginRight: 6 }}>임베드</span>
            {href ? (
              <a href={href} style={{ color: "var(--color-primary)", fontWeight: 600, textDecoration: "none" }}>
                {b.target}
              </a>
            ) : (
              <span style={{ color: "var(--text-muted)" }}>{b.target} — 연결된 문서 없음</span>
            )}
          </div>
        );
      }
    }
  });
}

/* ---------- 공개 컴포넌트 ---------- */

export default function MarkdownPreview({ markdown, resolveLink, onCreateLink, onTagClick, renderEmbed, headingIds = true }: MarkdownPreviewProps) {
  if (!markdown.trim()) {
    return (
      <div className="ws-doc-prose">
        <div className="ws-empty-hint">본문이 비어 있어요</div>
      </div>
    );
  }
  const doc = parseMarkdown(markdown);
  const ctx: Ctx = { resolveLink, onCreateLink, onTagClick, headingIds: headingIds ? headingIdMap(doc.blocks) : undefined };
  return <div className="ws-doc-prose">{renderBlocks(doc.blocks, ctx, "", renderEmbed)}</div>;
}

"use client";

/* =====================================================================
   BlockNote 커스텀 스키마 — 마크다운 전 기능을 편집기에서 살리기 위한 확장.

   BlockNote 기본 스키마가 모르는 문법이 넷 있다:
     [[위키링크]] · #태그 · ![[임베드]] · > [!NOTE] 콜아웃
   그리고 ==하이라이트== 는 스타일이 없다.

   이걸 커스텀 스펙으로 등록하지 않으면 lib/md/blocknote 가 만든 블록을
   편집기가 거부하거나(스키마 위반) 조용히 버린다. 즉 이 파일은 왕복
   충실도의 마지막 조각이다.

   렌더 규칙: 각 스펙의 시각은 MarkdownPreview 와 같은 토큰을 쓴다 —
   미리보기와 편집기가 다르게 보이면 안 된다.
   ===================================================================== */

import { BlockNoteSchema, defaultBlockSpecs, defaultInlineContentSpecs, defaultStyleSpecs } from "@blocknote/core";
import { createReactBlockSpec, createReactInlineContentSpec, createReactStyleSpec } from "@blocknote/react";

/* ───────────────────────── 스타일: ==하이라이트== ───────────────────────── */

export const HighlightStyle = createReactStyleSpec(
  { type: "highlight", propSchema: "boolean" },
  {
    render: ({ contentRef }) => (
      <mark
        ref={contentRef}
        style={{ background: "var(--color-primary-weak, #FDF0EC)", color: "inherit", padding: "0 3px", borderRadius: 4 }}
      />
    ),
  },
);

/* ───────────────────────── 인라인: [[위키링크]] ───────────────────────── */

export const WikilinkInline = createReactInlineContentSpec(
  {
    type: "wikilink",
    propSchema: {
      target: { default: "" as const },
      label: { default: "" as const },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const { target, label } = inlineContent.props;
      return (
        <span
          className="ws-wikilink"
          data-wikilink={target}
          title={`문서: ${target}`}
          style={{ color: "var(--color-primary)", fontWeight: 600, cursor: "pointer" }}
        >
          {label || target}
        </span>
      );
    },
  },
);

/* ───────────────────────── 인라인: #태그 ───────────────────────── */

export const TagInline = createReactInlineContentSpec(
  {
    type: "tag",
    propSchema: { name: { default: "" as const } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => (
      <span
        data-tag={inlineContent.props.name}
        style={{
          fontSize: "0.86em",
          fontWeight: 600,
          background: "var(--surface-sunken)",
          color: "var(--text-sub)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 999,
          padding: "1px 8px",
          margin: "0 1px",
        }}
      >
        #{inlineContent.props.name}
      </span>
    ),
  },
);

/* ───────────────────────── 인라인: 글 사이에 낀 이미지 ─────────────────────────
   BlockNote 의 image 는 블록이라 문단 중간에 들어갈 수 없다. 마크다운은
   되므로(`앞 ![](x) 뒤`), 인라인으로 남아야 하는 경우만 이 스펙이 받는다.
   이미지 하나로만 이뤄진 문단은 네이티브 image 블록으로 승격된다. */

export const ImageInline = createReactInlineContentSpec(
  {
    type: "mdimage",
    propSchema: {
      src: { default: "" as const },
      alt: { default: "" as const },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={inlineContent.props.src}
        alt={inlineContent.props.alt}
        style={{ maxHeight: "1.6em", verticalAlign: "text-bottom", borderRadius: 3, margin: "0 2px" }}
      />
    ),
  },
);

/* ───────────────────────── 블록: 콜아웃 ───────────────────────── */

const CALLOUT_META: Record<string, { color: string; label: string }> = {
  NOTE: { color: "var(--color-primary)", label: "노트" },
  INFO: { color: "var(--color-primary)", label: "정보" },
  TIP: { color: "#0CA678", label: "팁" },
  SUCCESS: { color: "#0CA678", label: "완료" },
  WARNING: { color: "#E0900F", label: "주의" },
  CAUTION: { color: "#E0900F", label: "주의" },
  DANGER: { color: "#D14343", label: "위험" },
  ERROR: { color: "#D14343", label: "오류" },
};
export const CALLOUT_KINDS = Object.keys(CALLOUT_META);
export const calloutMeta = (kind: string) => CALLOUT_META[kind?.toUpperCase()] ?? { color: "var(--text-sub)", label: kind };

export const CalloutBlock = createReactBlockSpec(
  {
    type: "callout",
    propSchema: { kind: { default: "NOTE" as const, values: CALLOUT_KINDS as readonly string[] } },
    content: "inline",
  },
  {
    // 제목줄이 content(인라인), 본문은 children — 마크다운 구조와 1:1 이다
    render: ({ block, contentRef, editor }) => {
      const meta = calloutMeta(String(block.props.kind));
      const cycle = () => {
        const i = CALLOUT_KINDS.indexOf(String(block.props.kind).toUpperCase());
        const next = CALLOUT_KINDS[(i + 1) % CALLOUT_KINDS.length];
        editor.updateBlock(block, { props: { kind: next } });
      };
      return (
        // 본문(children)은 BlockNote 가 이 div 바깥의 .bn-block-group 에 그린다.
        // 그래서 상자를 닫지 않고 왼쪽 액센트 바만 그린 뒤, globals.css 가 같은 바를
        // children 쪽으로 이어 붙여 하나의 블록처럼 보이게 한다(옵시디언 콜아웃과 같은 형태).
        <div
          data-callout-kind={String(block.props.kind).toUpperCase()}
          style={{
            borderLeft: `3px solid ${meta.color}`,
            padding: "8px 12px 4px",
            background: "var(--surface-sunken)",
            width: "100%",
          }}
        >
          <button
            type="button"
            contentEditable={false}
            onClick={cycle}
            title="종류 바꾸기"
            style={{
              font: "inherit",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.03em",
              color: meta.color,
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              display: "block",
              marginBottom: 2,
            }}
          >
            {meta.label}
          </button>
          <div ref={contentRef} style={{ fontSize: 13.5, color: "var(--text-body)" }} />
        </div>
      );
    },
  },
)();

/* ───────────────────────── 블록: ![[임베드]] ───────────────────────── */

export const EmbedBlock = createReactBlockSpec(
  {
    type: "embed",
    propSchema: { target: { default: "" as const } },
    content: "none",
  },
  {
    render: ({ block }) => (
      <div
        contentEditable={false}
        data-embed={String(block.props.target)}
        style={{
          border: "1px solid var(--border-subtle)",
          borderRadius: 10,
          padding: "10px 14px",
          background: "var(--surface-card)",
          fontSize: 13,
          width: "100%",
        }}
      >
        <span style={{ color: "var(--text-muted)", fontSize: 11.5, marginRight: 6 }}>임베드</span>
        <span style={{ color: "var(--color-primary)", fontWeight: 600 }}>{String(block.props.target)}</span>
      </div>
    ),
  },
)();

/* ───────────────────────── 스키마 ───────────────────────── */

export const wsSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    callout: CalloutBlock,
    embed: EmbedBlock,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: WikilinkInline,
    tag: TagInline,
    mdimage: ImageInline,
  },
  styleSpecs: {
    ...defaultStyleSpecs,
    highlight: HighlightStyle,
  },
});

export type WsSchema = typeof wsSchema;

// 주의: package.json 이 @tiptap/pm 을 3.27.1 로 정확히 고정한다 — BlockNote 와 같은 ProseMirror 사본을 쓰기 위해서다.
// BlockNote 를 올려 PM 사본이 둘이 되면 데코레이션이 조용히 깨진다(아래 테스트가 지킨다).
import { createExtension } from "@blocknote/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { slugifyHeading, uniqueIds } from "@/lib/md/headings";

/* =====================================================================
   편집기 헤딩 앵커 — ProseMirror 노드 데코레이션.

   미리보기는 헤딩에 id 를 달아 `#설치` 링크가 꽂히는데, 편집기(BlockNote)
   헤딩엔 id 가 없었다. DOM 에 직접 id 를 쓰면 안 된다(결정 29e188d):
   PM 이 그리지 않은 속성은 노드뷰 재생성 → DocToc MutationObserver 재수집
   → 다시 쓰기의 ~200ms 무한 루프를 부른다.

   데코레이션은 PM 이 스스로 그리는 속성이라 그 루프가 없다. 헤딩 노드에
   `Decoration.node(from, to, { id })` 를 걸면 PM 이 노드뷰의 바깥 dom
   (BlockNote 의 `div.bn-block-content`)에 id 를 단다 — 안쪽 h1~h6 가 아니라
   래퍼지만, getElementById·브라우저 `#해시` 이동은 래퍼로 충분하고 DocToc 은
   래퍼 id 를 읽는다.

   id 규칙은 미리보기(headingIdMap)와 같다: 문서 순서대로 모든 헤딩(h1~h6)을
   slugifyHeading 하고 uniqueIds 로 중복 번호를 매긴다. 빈 헤딩도 번호 계산엔
   들어가지만(미리보기와 같게) id 는 달지 않는다.
   ===================================================================== */

export type HeadingAnchor = { from: number; to: number; id: string | null };

/** 헤딩 인라인 → 평문. 미리보기의 inlineText 와 같은 규칙(위키링크=라벨, 태그=#이름, 이미지=alt). */
export function headingPlainText(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "wikilink") out += String(child.attrs.label || child.attrs.target || "");
    else if (child.type.name === "tag") out += "#" + String(child.attrs.name ?? "");
    else if (child.type.name === "mdimage") out += String(child.attrs.alt ?? "");
    else out += child.textContent;
  });
  return out;
}

/** 문서 순서대로 헤딩 노드의 범위와 id. 인라인 안으로는 내려가지 않는다 — 블록 수에 비례. */
export function headingAnchorIds(doc: PMNode): HeadingAnchor[] {
  const found: { from: number; to: number; text: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      found.push({ from: pos, to: pos + node.nodeSize, text: headingPlainText(node) });
      return false;
    }
    return !node.isTextblock;
  });
  const ids = uniqueIds(found.map((h) => slugifyHeading(h.text)));
  return found.map((h, i) => ({ from: h.from, to: h.to, id: h.text.trim() ? ids[i] : null }));
}

function buildSet(doc: PMNode): DecorationSet {
  const decos = headingAnchorIds(doc)
    .filter((a): a is HeadingAnchor & { id: string } => a.id !== null)
    .map((a) => Decoration.node(a.from, a.to, { id: a.id }));
  return DecorationSet.create(doc, decos);
}

export const headingAnchorsKey = new PluginKey<DecorationSet>("wsHeadingAnchors");

export function headingAnchorsPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: headingAnchorsKey,
    state: {
      init: (_config, state) => buildSet(state.doc),
      // 문서가 바뀐 트랜잭션에서만 다시 계산 — 선택 이동 등은 기존 집합을 매핑만 한다
      apply: (tr, set) => (tr.docChanged ? buildSet(tr.doc) : set.map(tr.mapping, tr.doc)),
    },
    props: {
      decorations: (state) => headingAnchorsKey.getState(state),
    },
  });
}

/** BlockNote 확장 — `useCreateBlockNote({ extensions: [HeadingAnchors()] })` 로 등록한다. */
export const HeadingAnchors = createExtension(() => ({
  key: "wsHeadingAnchors",
  prosemirrorPlugins: [headingAnchorsPlugin()],
}));

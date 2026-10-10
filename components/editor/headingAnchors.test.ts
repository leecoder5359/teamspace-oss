// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { realpathSync } from "node:fs";
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { buildTocFromDom, slugifyHeading, uniqueIds } from "@/lib/md/headings";
import { BlockNoteEditor } from "@blocknote/core";
import { HeadingAnchors, headingAnchorsPlugin, headingAnchorIds } from "./headingAnchors";

/* 실제 prosemirror-view 로 BlockNote 모양을 흉내 낸다 — 헤딩 노드뷰는 {dom: div.bn-block-content, contentDOM: h2}.
   결정 29e188d 의 재현(스크래치 repro.cjs)과 같은 틀: 노드뷰 생성 횟수를 세고 DocToc 식 MutationObserver 를 돌린다. */

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 2 } }, toDOM: () => ["h2", 0] },
    wikilink: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { target: { default: "" }, label: { default: "" } },
      toDOM: (n) => ["span", n.attrs.label || n.attrs.target],
    },
    text: { group: "inline" },
  },
});

const h = (t: string) => schema.node("heading", null, t ? schema.text(t) : []);
const p = (t: string) => schema.node("paragraph", null, t ? schema.text(t) : []);

let views = 0;
let view: EditorView | null = null;
let root: HTMLElement | null = null;
afterEach(() => {
  view?.destroy();
  root?.remove();
  view = null;
  root = null;
  views = 0;
});

function mount(blocks: PMNode[]) {
  root = document.createElement("div");
  document.body.appendChild(root);
  view = new EditorView(root, {
    state: EditorState.create({ doc: schema.node("doc", null, blocks), plugins: [headingAnchorsPlugin()] }),
    nodeViews: {
      heading: () => {
        views++;
        const dom = document.createElement("div");
        dom.className = "bn-block-content";
        dom.setAttribute("data-content-type", "heading");
        const contentDOM = document.createElement("h2");
        dom.appendChild(contentDOM);
        return { dom, contentDOM };
      },
    },
  });
  return view;
}

const wrappers = () => Array.from(root!.querySelectorAll<HTMLElement>(".bn-block-content"));
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** n 번째(0부터) 헤딩 노드의 위치 */
function headingPos(v: EditorView, n: number): number {
  let found = -1;
  let i = 0;
  v.state.doc.forEach((node, offset) => {
    if (node.type.name === "heading" && i++ === n) found = offset;
  });
  if (found < 0) throw new Error(`no heading ${n}`);
  return found;
}

describe("headingAnchors — PM 노드 데코레이션으로 편집기 헤딩에 id", () => {
  it("헤딩 래퍼에 slug id 를 달고, 중복엔 -2/-3, 빈 헤딩엔 달지 않는다 — 헤딩 요소엔 아무것도 안 쓴다", () => {
    mount([h("개요"), p("본문"), h("설치"), h("설치"), h(""), h("설치")]);
    expect(wrappers().map((w) => w.id)).toEqual(["개요", "설치", "설치-2", "", "설치-3"]);
    expect(Array.from(root!.querySelectorAll("h2")).map((e) => e.getAttribute("id"))).toEqual([null, null, null, null, null]);
    // 노드뷰가 그린 다른 속성은 그대로
    expect(wrappers().every((w) => w.getAttribute("data-content-type") === "heading")).toBe(true);
  });

  it("미리보기(uniqueIds)와 같은 번호 규칙 — 원래 있던 '설치-2' 는 그 주인에게 남긴다", () => {
    const texts = ["설치", "설치", "설치-2"];
    mount(texts.map(h));
    const expected = uniqueIds(texts.map(slugifyHeading));
    expect(expected).toEqual(["설치", "설치-3", "설치-2"]);
    expect(wrappers().map((w) => w.id)).toEqual(expected);
    // 목차가 래퍼 id 를 읽으면 같은 id 가 나온다(DocToc 의 existingId 경로)
    const toc = buildTocFromDom(wrappers().map((w) => ({ level: 2, text: w.textContent ?? "", id: w.id || null })));
    expect(toc.map((t) => t.id)).toEqual(expected);
  });

  it("인라인 위키링크·태그 글자도 미리보기(inlineText)처럼 slug 에 넣는다", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", null, [schema.text("참고 "), schema.node("wikilink", { target: "설계", label: "설계 문서" })]),
    ]);
    expect(headingAnchorIds(doc).map((a) => a.id)).toEqual([slugifyHeading("참고 설계 문서")]);
  });

  it("회귀(결정 29e188d): DocToc 식 관찰자가 돌아도 노드뷰를 다시 만들지 않는다", async () => {
    mount([h("개요"), h("설치"), h("사용")]);
    const created = views;
    expect(created).toBe(3);
    const before = wrappers();

    // DocToc 과 같은 모양: childList/characterData 관찰 + 200ms 디바운스 수집(편집기 헤딩엔 쓰지 않음)
    let collects = 0;
    let t: ReturnType<typeof setTimeout> | null = null;
    const collect = () => {
      collects++;
      buildTocFromDom(
        Array.from(root!.querySelectorAll<HTMLElement>("h2")).map((e) => ({
          level: 2,
          text: e.textContent ?? "",
          id: e.closest<HTMLElement>(".bn-block-content")?.id || null,
        })),
      );
    };
    const mo = new MutationObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(collect, 200);
    });
    mo.observe(root!, { childList: true, subtree: true, characterData: true });
    collect();
    await tick(500);
    mo.disconnect();
    if (t) clearTimeout(t);

    expect(views).toBe(created);
    expect(collects).toBe(1); // 첫 수집 뒤로 아무 변이도 없었다 — 루프 없음
    expect(wrappers().every((w, i) => w === before[i])).toBe(true);
    expect(wrappers().map((w) => w.id)).toEqual(["개요", "설치", "사용"]);
  });

  it("헤딩 글자를 고치면 id 가 바뀌고, 노드뷰는 그대로(속성만 갱신)", () => {
    const v = mount([h("개요"), h("설치")]);
    const created = views;
    const wrapper = wrappers()[1];
    const end = headingPos(v, 1) + v.state.doc.child(1).nodeSize - 1;
    v.dispatch(v.state.tr.insertText(" 방법", end));
    expect(wrappers()[1]).toBe(wrapper);
    expect(wrapper.id).toBe("설치-방법");
    expect(views).toBe(created);

    // 글자를 다 지우면 id 도 빠진다
    const from = headingPos(v, 1) + 1;
    v.dispatch(v.state.tr.delete(from, from + v.state.doc.child(1).content.size));
    expect(wrappers()[1].hasAttribute("id")).toBe(false);
  });

  it("앞에 같은 헤딩을 끼우면 번호가 uniqueIds 순서대로 밀린다", () => {
    const v = mount([p("머리말"), h("설치"), h("사용")]);
    v.dispatch(v.state.tr.insert(headingPos(v, 0), h("설치")));
    const texts = ["설치", "설치", "사용"];
    expect(wrappers().map((w) => w.id)).toEqual(uniqueIds(texts.map(slugifyHeading)));
    expect(wrappers().map((w) => w.id)).toEqual(["설치", "설치-2", "사용"]);
  });

  it("문서가 안 바뀐 트랜잭션(선택 이동)은 데코레이션 집합을 그대로 둔다", () => {
    const v = mount([h("개요"), p("본문")]);
    const plugin = v.state.plugins[0];
    const before = plugin.getState(v.state);
    v.dispatch(v.state.tr.setMeta("noop", true));
    expect(plugin.getState(v.state)).toBe(before);
  });

  it("실제 BlockNote 에 extensions 로 등록하면 헤딩 래퍼(.bn-block-content)에 id 가 붙고 관찰자 루프가 없다", async () => {
    const editor = BlockNoteEditor.create({ extensions: [HeadingAnchors()] });
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    try {
      editor.replaceBlocks(editor.document, [
        { type: "heading", props: { level: 2 }, content: "설치" },
        { type: "paragraph", content: "본문" },
        { type: "heading", props: { level: 3 }, content: "설치" },
      ]);
      const headingWrappers = () =>
        Array.from(el.querySelectorAll<HTMLElement>('.bn-block-content[data-content-type="heading"]'));
      const before = headingWrappers();
      expect(before.map((w) => w.id)).toEqual(["설치", "설치-2"]);
      expect(before.map((w) => w.querySelector("h2,h3")?.getAttribute("id"))).toEqual([null, null]);

      let mutations = 0;
      const mo = new MutationObserver(() => mutations++);
      mo.observe(el, { childList: true, subtree: true, characterData: true });
      await tick(500);
      mo.disconnect();
      expect(mutations).toBe(0);
      expect(headingWrappers().every((w, i) => w === before[i])).toBe(true);

      // 글자 수정 → id 갱신(BlockNote API 경로)
      editor.updateBlock(editor.document[2], { content: "사용" });
      expect(headingWrappers().map((w) => w.id)).toEqual(["설치", "사용"]);
    } finally {
      editor.unmount();
      el.remove();
    }
  });
});

describe("@tiptap/pm 핀 가드", () => {
  it("@tiptap/pm 과 @blocknote/core 가 같은 prosemirror-view 사본을 쓴다", () => {
    const req = createRequire(import.meta.url);
    // package.json 은 exports 에 없을 수 있어 실제 진입점의 디렉토리에서 출발한다.
    const from = (entry: string) => dirname(req.resolve(entry));
    const resolveFrom = (dir: string) => realpathSync(req.resolve("prosemirror-view", { paths: [dir] }));
    expect(resolveFrom(from("@tiptap/pm/state"))).toBe(resolveFrom(from("@blocknote/core")));
  });
});

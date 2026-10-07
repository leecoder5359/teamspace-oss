import { describe, it, expect } from "vitest";
import { buildGraph, type GraphInput } from "./knowledgeGraph";

const ID = (n: string) => `c${n.padEnd(24, "0")}`; // 25자 cuid 모양
const doc = (n: string, title: string, markdown = "", extra: Partial<GraphInput["docs"][number]> = {}) => ({
  id: ID(n), title, markdown, parentId: null, projectId: null, ...extra,
});
const base = (over: Partial<GraphInput>): GraphInput => ({ docs: [], projects: [], objects: [], stored: [], ...over });
const edge = (g: ReturnType<typeof buildGraph>, a: string, b: string) =>
  g.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));

describe("buildGraph", () => {
  it("link: [[제목]] → 추출", () => {
    const g = buildGraph(base({ docs: [doc("a", "알파 문서", "[[베타 문서]]"), doc("b", "베타 문서")] }));
    expect(edge(g, ID("a"), ID("b"))).toMatchObject({ from: ID("a"), to: ID("b"), kind: "link", tag: "추출" });
  });

  it("link: 대괄호로 시작하는 제목([[[반장] 제목]]·별칭)도 link — 언급으로 새지 않는다", () => {
    const g = buildGraph(base({ docs: [
      doc("a", "[반장] 핸드오프 문서 모음", "- [[[반장 B1] 아키텍처 개요]]"),
      doc("b", "[반장 B1] 아키텍처 개요", "상위: [[[반장] 핸드오프 문서 모음|허브]]"),
    ] }));
    expect(edge(g, ID("a"), ID("b"))).toMatchObject({ kind: "link", kinds: ["link"] });
  });

  it("ref: 본문의 전체 cuid·유일한 9자 짧은 id → 추출", () => {
    const g = buildGraph(base({ docs: [
      doc("a", "알파 문서", `참고 ${ID("b")} 그리고 ${ID("c").slice(0, 9)}`),
      doc("b", "베타 문서"), doc("c", "감마 문서"),
    ] }));
    expect(edge(g, ID("a"), ID("b"))?.kind).toBe("ref");
    expect(edge(g, ID("a"), ID("c"))?.kind).toBe("ref");
  });

  it("ref: 짧은 id 가 여러 노드에 겹치면 무시", () => {
    const x = "cdup00000" + "1".repeat(16);
    const y = "cdup00000" + "2".repeat(16);
    const g = buildGraph(base({ docs: [
      doc("a", "알파 문서", "참고 cdup00000 끝"),
      { ...doc("x", "엑스 문서"), id: x }, { ...doc("y", "와이 문서"), id: y },
    ] }));
    expect(g.edges).toHaveLength(0);
  });

  it("mention: 제목 텍스트 → 추론. 6자 미만·중복 제목·코드펜스 안은 제외", () => {
    const g = buildGraph(base({ docs: [
      doc("a", "알파 문서", "배포 가이드 상세를 보라\n```\n결제 흐름 설계\n```\nplan 그리고 중복 제목입니다"),
      doc("b", "배포 가이드 상세"), doc("c", "결제 흐름 설계"), doc("d", "plan"),
      doc("e", "중복 제목입니다"), doc("f", "중복 제목입니다", "", {}),
    ] }));
    expect(edge(g, ID("a"), ID("b"))).toMatchObject({ kind: "mention", tag: "추론" });
    expect(edge(g, ID("a"), ID("c"))).toBeUndefined();
    expect(edge(g, ID("a"), ID("d"))).toBeUndefined();
    expect(edge(g, ID("a"), ID("e"))).toBeUndefined(); // 중복 제목은 본문에 있어도 어느 쪽에도 안 잇는다
    expect(edge(g, ID("a"), ID("f"))).toBeUndefined();
  });

  describe("A4: 언급 정밀도", () => {
    it("공백·줄바꿈 차이는 무시한다(본문·제목 모두 공백 접기)", () => {
      const g = buildGraph(base({ docs: [
        doc("a", "알파 문서", "자세한 건 배포\n가이드   상세 참고"),
        doc("b", "배포  가이드 상세"),
      ] }));
      expect(edge(g, ID("a"), ID("b"))?.kind).toBe("mention");
    });

    it("앞머리 YAML 프론트매터는 ref/언급 스캔에서 뺀다(별칭 링크는 그대로)", () => {
      const g = buildGraph(base({ docs: [
        doc("a", "알파 문서", `---\nsource: 배포 가이드 상세\nid: ${ID("c")}\n---\n본문은 [[베타 별칭]] 만`),
        doc("b", "베타 문서", "---\naliases: [베타 별칭]\n---\n"),
        doc("c", "감마 문서"), doc("d", "배포 가이드 상세"),
      ] }));
      expect(edge(g, ID("a"), ID("b"))?.kind).toBe("link");
      expect(edge(g, ID("a"), ID("c"))).toBeUndefined();
      expect(edge(g, ID("a"), ID("d"))).toBeUndefined();
    });

    it("프론트매터의 [[링크]] 는 link 로 센다(속성 링크), 프론트매터의 id 는 ref 가 아니다", () => {
      const g = buildGraph(base({ docs: [
        doc("a", "알파 문서", `---\nrelated: "[[베타 문서 하나]]"\nsource: ${ID("c")}\n---\n본문`),
        doc("b", "베타 문서 하나"), doc("c", "감마 문서"),
      ] }));
      expect(edge(g, ID("a"), ID("b"))?.kind).toBe("link");
      expect(edge(g, ID("a"), ID("c"))).toBeUndefined();
    });

    it("코드펜스 안의 [[위키링크]] 는 link 로 세지 않는다(ref/언급과 일관)", () => {
      const g = buildGraph(base({ docs: [
        doc("a", "알파 문서", "예시:\n```\n[[베타 문서]]\n```"),
        doc("b", "베타 문서"),
      ] }));
      expect(edge(g, ID("a"), ID("b"))).toBeUndefined();
    });
  });

  it("mention: 겹치는/포함되는 제목은 둘 다 언급으로 잡힌다(대소문자 무시)", () => {
    const g = buildGraph(base({ docs: [
      doc("a", "알파 문서", "자세한 건 배포 가이드 상세와 Release Notes 참고"),
      doc("b", "배포 가이드"), doc("c", "배포 가이드 상세"), doc("d", "release notes"), doc("e", "가이드 상세와 무관"),
    ] }));
    expect(edge(g, ID("a"), ID("b"))?.kind).toBe("mention");
    expect(edge(g, ID("a"), ID("c"))?.kind).toBe("mention");
    expect(edge(g, ID("a"), ID("d"))?.kind).toBe("mention");
    expect(edge(g, ID("a"), ID("e"))).toBeUndefined();
  });

  it("contains: 부모→자식·프로젝트→문서·태스크→본문 문서 → 추출", () => {
    const g = buildGraph(base({
      docs: [doc("p", "부모 문서"), doc("k", "자식 문서", "", { parentId: ID("p"), projectId: ID("j") })],
      projects: [{ id: ID("j"), name: "프로젝트 제이" }],
      objects: [{ id: ID("t"), type: "task", title: "태스크", text: "", projectId: null, boardId: ID("bd"), contentPageId: ID("p") }],
    }));
    expect(edge(g, ID("p"), ID("k"))).toMatchObject({ from: ID("p"), kind: "contains", tag: "추출" });
    expect(edge(g, ID("j"), ID("k"))).toMatchObject({ from: ID("j"), kind: "contains" });
    expect(edge(g, ID("t"), ID("p"))).toMatchObject({ from: ID("t"), kind: "contains" });
    expect(g.nodes.find((n) => n.id === ID("j"))).toMatchObject({ type: "project", href: "/projects" });
  });

  it("pair: 같은 식별자(W4-3)를 공유하는 2~4개 문서 → 추론", () => {
    const g = buildGraph(base({ docs: [
      doc("a", "W4-3 스케줄 상한 — 설계"), doc("b", "W4-3 스케줄 상한 — 구현 계획"), doc("c", "W4-4 템플릿 — 구현 계획"),
    ] }));
    expect(edge(g, ID("a"), ID("b"))).toMatchObject({ kind: "pair", tag: "추론" });
    expect(edge(g, ID("a"), ID("c"))).toBeUndefined();
  });

  it("pair: 식별자 그룹이 5개 이상이면 잇지 않는다(범람 방지)", () => {
    const docs = ["a", "b", "c", "d", "e"].map((n) => doc(n, `S2 항목 ${n} 문서`));
    expect(buildGraph(base({ docs })).edges).toHaveLength(0);
  });

  it("related: 저장 간선 → 모호, 끝점이 노드가 아니면 버린다", () => {
    const g = buildGraph(base({
      docs: [doc("a", "알파 문서"), doc("b", "베타 문서")],
      stored: [{ fromId: ID("a"), toId: ID("b"), kind: "related" }, { fromId: ID("a"), toId: ID("zz"), kind: "related" }],
    }));
    expect(g.edges).toEqual([{ from: ID("a"), to: ID("b"), kind: "related", kinds: ["related"], tag: "모호" }]);
  });

  it("같은 쌍의 여러 근거는 간선 하나로 병합, tag 는 가장 강한 것", () => {
    // 제목은 6자 이상이어야 mention 대상 → "… 하나" 로 늘린다
    const g = buildGraph(base({ docs: [doc("a", "알파 문서 하나", `[[베타 문서 하나]]`), doc("b", "베타 문서 하나", "알파 문서 하나 참고")] }));
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ kind: "link", tag: "추출" });
    expect(g.edges[0].kinds.sort()).toEqual(["link", "mention"]);
  });

  it("객체 노드: 간선이 없으면 제외, 본문 ref/mention 이 있으면 포함(href 포함)", () => {
    const g = buildGraph(base({
      docs: [doc("a", "알파 문서")],
      objects: [
        { id: ID("d1"), type: "decision", title: "결정1", text: `근거 ${ID("a")}`, projectId: null },
        { id: ID("l1"), type: "lesson", title: "레슨1", text: "관계 없음", projectId: null },
      ],
    }));
    expect(g.nodes.map((n) => n.id)).toEqual(expect.arrayContaining([ID("a"), ID("d1")]));
    expect(g.nodes.find((n) => n.id === ID("l1"))).toBeUndefined();
    expect(g.nodes.find((n) => n.id === ID("d1"))?.href).toBe("/docs?cat=decisions");
  });

  it("프로젝트 노드: 소속 문서가 없으면 제외. 객체→프로젝트 간선은 만들지 않는다", () => {
    const g = buildGraph(base({
      projects: [{ id: ID("j"), name: "빈 프로젝트" }],
      objects: [{ id: ID("d1"), type: "decision", title: "결정1", text: "", projectId: ID("j") }],
    }));
    expect(g.nodes).toHaveLength(0);
  });

  it("자기 참조는 간선이 아니다", () => {
    const g = buildGraph(base({ docs: [doc("a", "알파 문서", `[[알파 문서]] ${ID("a")}`)] }));
    expect(g.edges).toHaveLength(0);
  });

  describe("A6: 빈틈", () => {
    it("병합 방향 뒤집힘: 약한 a→b 가 먼저, 강한 b→a 가 나중이면 from/to 는 강한 쪽을 따른다", () => {
      const g = buildGraph(base({ docs: [
        doc("a", "알파 문서 하나", "베타 문서 하나 참고"), // mention a→b (먼저 스캔)
        doc("b", "베타 문서 하나", "[[알파 문서 하나]]"), // link b→a (나중)
      ] }));
      expect(g.edges).toHaveLength(1);
      expect(g.edges[0]).toMatchObject({ from: ID("b"), to: ID("a"), kind: "link", tag: "추출" });
      expect([...g.edges[0].kinds].sort()).toEqual(["link", "mention"]);
    });

    it("태스크 href: contentPageId 없으면 /p/<boardId>, 둘 다 없으면 null", () => {
      const g = buildGraph(base({
        docs: [doc("a", "알파 문서")],
        objects: [
          { id: ID("t1"), type: "task", title: "태스크1", text: `참고 ${ID("a")}`, projectId: null, boardId: "board1", contentPageId: null },
          { id: ID("t2"), type: "task", title: "태스크2", text: `참고 ${ID("a")}`, projectId: null },
        ],
      }));
      expect(g.nodes.find((n) => n.id === ID("t1"))?.href).toBe("/p/board1");
      expect(g.nodes.find((n) => n.id === ID("t2"))?.href).toBeNull();
    });

    it("프론트매터 aliases 로 [[별칭]] 링크가 해석된다", () => {
      const g = buildGraph(base({ docs: [
        doc("a", "알파 문서", "[[ADR-7]] 참고"),
        doc("b", "아키텍처 결정 일곱", "---\naliases:\n  - ADR-7\n---\n본문"),
      ] }));
      expect(edge(g, ID("a"), ID("b"))).toMatchObject({ from: ID("a"), to: ID("b"), kind: "link" });
    });

    it("문서 본문의 객체(결정) id → 문서–결정 ref 간선", () => {
      const g = buildGraph(base({
        docs: [doc("a", "알파 문서", `이 결정을 따른다: ${ID("d1")}`)],
        objects: [{ id: ID("d1"), type: "decision", title: "결정1", text: "", projectId: null }],
      }));
      expect(edge(g, ID("a"), ID("d1"))).toMatchObject({ from: ID("a"), to: ID("d1"), kind: "ref", tag: "추출" });
      expect(g.nodes.find((n) => n.id === ID("d1"))?.type).toBe("decision");
    });
  });
});

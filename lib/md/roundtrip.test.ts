import { describe, it, expect } from "vitest";
import { parseMarkdown } from "@/lib/md/parse";
import { serializeMarkdown } from "@/lib/md/serialize";

/** 정규형 입력은 파싱→직렬화해도 그대로여야 한다. */
const canonical = (md: string) => expect(serializeMarkdown(parseMarkdown(md))).toBe(md);

/**
 * 어떤 입력이든 한 번 정규화되면 그 뒤로는 고정점이어야 한다.
 * 이게 깨지면 문서를 열고 저장할 때마다 본문이 조금씩 흔들린다 —
 * BlockNote 를 붙이기 전에 반드시 보장해야 하는 성질.
 */
function fixedPoint(md: string) {
  const once = serializeMarkdown(parseMarkdown(md));
  const twice = serializeMarkdown(parseMarkdown(once));
  expect(twice).toBe(once);
  return once;
}

describe("왕복 — 정규형 보존", () => {
  it("헤딩과 인라인 서식", () => {
    canonical("# 제목\n\n**굵게** *기울임* ~~취소~~ ==강조== `코드`");
  });

  it("링크·이미지·위키링크·태그", () => {
    canonical("[문서](https://x.dev/a) ![샷](/uploads/w/a.png) [[대상|표시]] #결정");
  });

  it("대괄호 제목 위키링크·임베드", () => {
    canonical("상위: [[[반장 핸드오프 B1] 시스템 아키텍처 개요]] · [[[반장] 핸드오프 문서 모음|허브]]");
    canonical("![[[반장] 노트]]");
  });

  it("중첩 리스트 — 부모 항목과 자식 사이엔 빈 줄이 없다", () => {
    canonical("- 상위\n  - 하위\n    - 더하위\n- 상위2");
  });

  it("체크박스", () => {
    canonical("- [ ] 안함\n- [x] 함");
  });

  it("번호 리스트 — 시작 번호 유지", () => {
    canonical("3. 셋\n4. 넷");
  });

  it("코드펜스 — 언어와 내부 원문", () => {
    canonical("```ts\nconst a = 1; // **not bold**\n```");
  });

  it("표 — 정렬 유지", () => {
    canonical("| 이름 | 값 |\n| :-- | --: |\n| **A** | 1 |");
  });

  it("인용", () => {
    canonical("> 인용문이다");
  });

  it("콜아웃", () => {
    canonical("> [!WARNING] 주의\n> 본문이다");
  });

  it("구분선·임베드", () => {
    canonical("---\n\n![[설계 노트]]");
  });

  it("프론트매터", () => {
    canonical("---\ntitle: 로요\naliases: [LOYO, 단골노트]\n---\n\n본문");
  });
});

describe("왕복 — 비정규 입력도 한 번 정규화 뒤 고정점", () => {
  it("_기울임_ → *기울임*", () => {
    expect(fixedPoint("_기울임_")).toBe("*기울임*");
  });

  it("* 불릿 → - 불릿", () => {
    expect(fixedPoint("* 하나\n* 둘")).toBe("- 하나\n- 둘");
  });

  it("*** 구분선 → ---", () => {
    expect(fixedPoint("***")).toBe("---");
  });

  it("4칸 중첩 → 2칸 중첩", () => {
    expect(fixedPoint("- 상위\n    - 하위")).toBe("- 상위\n  - 하위");
  });

  it("여러 줄 문단은 한 줄로 합쳐진다(소프트 줄바꿈 = 공백)", () => {
    expect(fixedPoint("첫 줄\n둘째 줄")).toBe("첫 줄 둘째 줄");
  });

  it("블록 사이 빈 줄이 여러 개여도 하나로", () => {
    expect(fixedPoint("가\n\n\n\n나")).toBe("가\n\n나");
  });

  it("복합 문서 전체", () => {
    const messy = [
      "---",
      "title: 설계",
      "aliases:",
      "  - 디자인",
      "---",
      "",
      "# 개요",
      "여러 줄로",
      "쓴 문단",
      "",
      "> [!NOTE] 참고",
      "> 안에 리스트도 된다",
      "> * 하나",
      "> * 둘",
      "",
      "1. 첫째",
      "    1. 안쪽",
      "",
      "| A | B |",
      "|--|--|",
      "| 1 | 2 |",
      "",
      "```js",
      "if (a) { }",
      "```",
      "",
      "![[다른 노트]]",
    ].join("\n");
    fixedPoint(messy); // 던지지 않으면 통과
  });
});

describe("왕복 — 코드 내부는 절대 변형되지 않는다", () => {
  it("펜스 안의 마크다운 문법이 살아남는다", () => {
    const md = "```\n# 제목 아님\n- 리스트 아님\n**굵게 아님** [[링크 아님]]\n```";
    canonical(md);
  });

  it("인라인 코드 안의 문법도 그대로", () => {
    canonical("`**a** [[b]] #c`");
  });
});

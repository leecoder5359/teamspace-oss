import { describe, it, expect } from "vitest";
import { createAnchor, locateAnchor, type TextAnchor } from "@/lib/anchor";

const DOC = "처음 문단입니다.\n\n두 번째 문단에는 중요한 문장이 있습니다.\n\n마지막 문단입니다.\n";

describe("createAnchor — 선택 범위를 앵커로", () => {
  it("인용문과 앞뒤 문맥을 담는다", () => {
    const start = DOC.indexOf("중요한 문장");
    const a = createAnchor(DOC, start, start + "중요한 문장".length);
    expect(a!.quote).toBe("중요한 문장");
    expect(a!.prefix.endsWith("두 번째 문단에는 ")).toBe(true);
    expect(a!.suffix.startsWith("이 있습니다")).toBe(true);
  });

  it("문서 처음·끝에서도 만들어진다(문맥이 짧을 뿐)", () => {
    const head = createAnchor(DOC, 0, 2);
    expect(head!.quote).toBe("처음");
    expect(head!.prefix).toBe("");

    const tailStart = DOC.length - 1;
    const tail = createAnchor(DOC, tailStart - 4, tailStart);
    expect(tail!.suffix.length).toBeLessThanOrEqual(32);
  });

  it("범위가 뒤집혀 있으면 바로잡는다", () => {
    const s = DOC.indexOf("중요한");
    expect(createAnchor(DOC, s + 3, s)!.quote).toBe("중요한"); // s..s+3 = 3글자
  });

  it("빈 선택은 앵커가 아니다", () => {
    expect(createAnchor(DOC, 5, 5)).toBeNull();
  });
});

describe("locateAnchor — 편집된 문서에서 제자리 찾기", () => {
  const anchorFor = (text: string, doc = DOC): TextAnchor => {
    const s = doc.indexOf(text);
    return createAnchor(doc, s, s + text.length)!;
  };

  it("그대로인 문서에서는 원래 위치", () => {
    const a = anchorFor("중요한 문장");
    const hit = locateAnchor(DOC, a);
    expect(hit).not.toBeNull();
    expect(DOC.slice(hit!.start, hit!.end)).toBe("중요한 문장");
  });

  it("앞에 내용이 추가돼 위치가 밀려도 찾는다", () => {
    const a = anchorFor("중요한 문장");
    const edited = "새로 추가된 머리말입니다.\n\n" + DOC;
    const hit = locateAnchor(edited, a);
    expect(edited.slice(hit!.start, hit!.end)).toBe("중요한 문장");
  });

  it("같은 문구가 여러 번 나오면 **문맥으로** 고른다", () => {
    const doc = "가 부분: 반복 문구 입니다.\n나 부분: 반복 문구 입니다.\n";
    const second = doc.lastIndexOf("반복 문구");
    const a = createAnchor(doc, second, second + "반복 문구".length)!;
    const hit = locateAnchor(doc, a);
    expect(hit!.start).toBe(second); // 첫 번째가 아니라 두 번째를 짚어야 한다
  });

  it("문맥이 조금 바뀌어도 인용문이 유일하면 찾는다", () => {
    const a = anchorFor("중요한 문장");
    const edited = DOC.replace("두 번째 문단에는", "둘째 문단에는 아주");
    const hit = locateAnchor(edited, a);
    expect(edited.slice(hit!.start, hit!.end)).toBe("중요한 문장");
  });

  it("인용문이 지워졌으면 null — 엉뚱한 곳에 붙이지 않는다", () => {
    const a = anchorFor("중요한 문장");
    const edited = DOC.replace("중요한 문장이 있습니다", "다 지웠습니다");
    expect(locateAnchor(edited, a)).toBeNull();
  });

  it("공백만 달라진 경우도 찾는다(줄바꿈·들여쓰기 정리)", () => {
    const a = anchorFor("중요한 문장");
    const edited = DOC.replace("중요한 문장", "중요한   문장");
    const hit = locateAnchor(edited, a);
    expect(hit).not.toBeNull();
    expect(edited.slice(hit!.start, hit!.end).replace(/\s+/g, " ")).toBe("중요한 문장");
  });

  it("빈 문서에서는 null", () => {
    expect(locateAnchor("", anchorFor("중요한 문장"))).toBeNull();
  });

  it("앵커가 망가져 있어도 던지지 않는다", () => {
    expect(locateAnchor(DOC, { quote: "", prefix: "", suffix: "" })).toBeNull();
  });

  it("아주 긴 문서에서도 답을 낸다(성능 안전판)", () => {
    const big = "채우는 줄입니다.\n".repeat(20000) + DOC;
    const a = anchorFor("중요한 문장");
    const hit = locateAnchor(big, a);
    expect(big.slice(hit!.start, hit!.end)).toBe("중요한 문장");
  });
});

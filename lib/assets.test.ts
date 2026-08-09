import { describe, it, expect } from "vitest";
import {
  extractLinks,
  isExternal,
  decodeHref,
  resolveZipPath,
  toRelativeHref,
  rewriteHrefs,
  uploadFileName,
  uploadsHrefFile,
} from "@/lib/assets";

describe("extractLinks", () => {
  it("이미지와 링크의 목적지를 모두 뽑는다", () => {
    const md = "![그림](/uploads/ws/a.png)\n\n[문서](./b.pdf) 와 [바깥](https://x.com)\n";
    expect(extractLinks(md).map((l) => l.href)).toEqual(["/uploads/ws/a.png", "./b.pdf", "https://x.com"]);
  });

  it("제목이 붙은 형태도 목적지만 뽑는다", () => {
    expect(extractLinks('![x](/uploads/ws/a.png "설명")').map((l) => l.href)).toEqual(["/uploads/ws/a.png"]);
  });

  it("꺾쇠로 감싼 목적지(공백 포함)를 뽑는다", () => {
    expect(extractLinks("![x](<내 그림 2.png>)").map((l) => l.href)).toEqual(["내 그림 2.png"]);
  });

  it("코드블록·인라인코드 안은 건드리지 않는다", () => {
    const md = "```\n![x](/uploads/ws/a.png)\n```\n\n`![y](/uploads/ws/b.png)`\n";
    expect(extractLinks(md)).toEqual([]);
  });

  it("위키링크·해시태그는 대상이 아니다", () => {
    expect(extractLinks("[[다른 문서]] #태그")).toEqual([]);
  });
});

describe("isExternal", () => {
  it("스킴이 있거나 앵커면 바깥", () => {
    for (const h of ["https://x.com/a.png", "http://x/a", "mailto:a@b.c", "data:image/png;base64,AAA", "//cdn/x.png", "#섹션"])
      expect(isExternal(h)).toBe(true);
  });

  it("상대·루트 경로는 안쪽", () => {
    for (const h of ["a.png", "./a.png", "../attachments/a.png", "/uploads/ws/a.png"]) expect(isExternal(h)).toBe(false);
  });
});

describe("decodeHref", () => {
  it("퍼센트 인코딩을 푼다", () => {
    expect(decodeHref("../attachments/%ED%95%9C%EA%B8%80%20%EA%B7%B8%EB%A6%BC.png")).toBe("../attachments/한글 그림.png");
  });

  it("쿼리·프래그먼트를 떼어낸다", () => {
    expect(decodeHref("a.png?v=2#frag")).toBe("a.png");
  });

  it("깨진 인코딩이면 원문을 그대로 준다(던지지 않는다)", () => {
    expect(decodeHref("a%ZZ.png")).toBe("a%ZZ.png");
  });
});

describe("resolveZipPath — 문서 위치 기준 상대경로 해석", () => {
  it("같은 폴더", () => {
    expect(resolveZipPath("기획/스펙.md", "그림.png")).toBe("기획/그림.png");
  });

  it("상위로 올라가기", () => {
    expect(resolveZipPath("docs/프로젝트/노트.md", "../../attachments/a.png")).toBe("attachments/a.png");
  });

  it("./ 는 무시", () => {
    expect(resolveZipPath("a/b.md", "./c.png")).toBe("a/c.png");
  });

  it("루트 밖으로 나가면 null", () => {
    expect(resolveZipPath("a/b.md", "../../../etc/passwd")).toBeNull();
  });

  it("절대 경로는 zip 안에서 해석하지 않는다", () => {
    expect(resolveZipPath("a/b.md", "/uploads/ws/a.png")).toBeNull();
  });
});

describe("toRelativeHref — 내보내기용 상대경로", () => {
  it("프로젝트 폴더 안의 문서에서 attachments 로", () => {
    expect(toRelativeHref("docs/프로젝트/노트.md", "attachments/a.png")).toBe("../../attachments/a.png");
  });

  it("docs 바로 아래 문서에서", () => {
    expect(toRelativeHref("docs/노트.md", "attachments/a.png")).toBe("../attachments/a.png");
  });

  it("공백·한글은 퍼센트 인코딩한다(마크다운이 깨지지 않게)", () => {
    expect(toRelativeHref("docs/a.md", "attachments/내 그림.png")).toBe("../attachments/%EB%82%B4%20%EA%B7%B8%EB%A6%BC.png");
  });

  it("왕복: toRelativeHref → decodeHref → resolveZipPath 는 원래 경로로 돌아온다", () => {
    const doc = "docs/프로젝트/노트.md";
    const asset = "attachments/내 그림 (1).png";
    expect(resolveZipPath(doc, decodeHref(toRelativeHref(doc, asset)))).toBe(asset);
  });
});

describe("rewriteHrefs", () => {
  it("지정한 목적지만 바꾼다", () => {
    const md = "![a](/uploads/ws/a.png)\n[b](/uploads/ws/b.pdf)\n[밖](https://x.com/a.png)\n";
    const out = rewriteHrefs(md, { "/uploads/ws/a.png": "../attachments/a.png" });
    expect(out).toBe("![a](../attachments/a.png)\n[b](/uploads/ws/b.pdf)\n[밖](https://x.com/a.png)\n");
  });

  it("제목·꺾쇠 형태도 보존하며 바꾼다", () => {
    expect(rewriteHrefs('![a](/u/a.png "설명")', { "/u/a.png": "x.png" })).toBe('![a](x.png "설명")');
    // 꺾쇠는 그대로 둔다 — 목적지만 갈아끼우고 저자가 쓴 형태는 건드리지 않는다(꺾쇠도 유효한 마크다운).
    expect(rewriteHrefs("![a](<내 그림.png>)", { "내 그림.png": "/uploads/ws/1-a.png" })).toBe("![a](</uploads/ws/1-a.png>)");
  });

  it("같은 목적지가 여러 번 나오면 모두 바꾼다", () => {
    expect(rewriteHrefs("![](a.png) 그리고 ![](a.png)", { "a.png": "b.png" })).toBe("![](b.png) 그리고 ![](b.png)");
  });

  it("코드블록 안은 그대로 둔다", () => {
    const md = "```\n![](a.png)\n```\n![](a.png)\n";
    expect(rewriteHrefs(md, { "a.png": "b.png" })).toBe("```\n![](a.png)\n```\n![](b.png)\n");
  });

  it("매핑이 비면 원문 그대로", () => {
    const md = "![a](a.png)";
    expect(rewriteHrefs(md, {})).toBe(md);
  });
});

describe("uploadFileName", () => {
  const H = "994e6e36ffff";

  it("내용 해시 8자리 + 원래 이름", () => {
    expect(uploadFileName("테스트 그림.png", H)).toBe("994e6e36-테스트 그림.png");
  });

  it("경로가 붙어 있으면 파일명만 쓴다", () => {
    expect(uploadFileName("attachments/a/b.png", H)).toBe("994e6e36-b.png");
  });

  it("이미 붙어 있는 해시 접두는 겹쳐 쌓지 않는다(왕복해도 이름이 자라지 않는다)", () => {
    const once = uploadFileName("테스트 그림.png", H);
    const twice = uploadFileName(once, H);
    expect(twice).toBe(once);
    expect(uploadFileName(twice, H)).toBe(once);
  });

  it("파일시스템에 위험한 문자는 치환한다", () => {
    expect(uploadFileName('a:b*c?"d<e>f|g.png', H)).toBe("994e6e36-a_b_c__d_e_f_g.png");
  });

  it("이름이 비면 대체 이름", () => {
    expect(uploadFileName("", H)).toBe("994e6e36-file");
  });
});

describe("uploadsHrefFile — /uploads/<ws>/<파일> 에서 파일명 뽑기", () => {
  it("내 워크스페이스 업로드만 인정한다", () => {
    expect(uploadsHrefFile("/uploads/ws1/abc-a.png", "ws1")).toBe("abc-a.png");
    expect(uploadsHrefFile("/uploads/ws2/abc-a.png", "ws1")).toBeNull();
    expect(uploadsHrefFile("/other/ws1/a.png", "ws1")).toBeNull();
  });

  it("퍼센트 인코딩된 한글 파일명을 푼다", () => {
    expect(uploadsHrefFile("/uploads/ws1/1234-%ED%95%9C%EA%B8%80.png", "ws1")).toBe("1234-한글.png");
  });

  it("경로 탈출은 거절한다", () => {
    expect(uploadsHrefFile("/uploads/ws1/../../etc/passwd", "ws1")).toBeNull();
    expect(uploadsHrefFile("/uploads/ws1/sub/a.png", "ws1")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { createZip } from "@/lib/zip";
import { normalizeBundlePath, validateBundle, mimeFor, SITE_LIMITS } from "./bundle";

const zip = (entries: Record<string, string>) =>
  createZip(Object.entries(entries).map(([path, data]) => ({ path, data })));

describe("normalizeBundlePath", () => {
  it("정상 경로는 정리해서 돌려준다", () => {
    expect(normalizeBundlePath("a/./b.css")).toBe("a/b.css");
    expect(normalizeBundlePath("index.html")).toBe("index.html");
  });
  it("탈출·절대경로·드라이브·백슬래시·제어문자는 null", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a\u0000b", ""]) {
      expect(normalizeBundlePath(bad), bad).toBeNull();
    }
  });
});

describe("validateBundle", () => {
  it("단일 html 은 index.html 로 저장한다", () => {
    const r = validateBundle({ filename: "Report.HTML", data: Buffer.from("<h1>hi</h1>") });
    expect(r).toMatchObject({ ok: true, files: [{ path: "index.html" }] });
  });

  it("html·zip 이 아니면 거부", () => {
    expect(validateBundle({ filename: "a.pdf", data: Buffer.from("x") })).toMatchObject({ ok: false });
  });

  it("최상위 폴더 하나는 벗겨낸다", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "dist/index.html": "<p>", "dist/app.js": "1" }) });
    expect(r.ok && r.files.map((f) => f.path).sort()).toEqual(["app.js", "index.html"]);
  });

  it("숨김·__MACOSX 는 건너뛰고 skipped 에 남긴다", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "index.html": "<p>", ".DS_Store": "x", "__MACOSX/._index.html": "x" }) });
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["index.html"]);
    expect(r.ok && r.skipped.length).toBe(2);
  });

  it("예약 폴더 __ts/ 는 담지 않는다(/pub 내비 스크립트 자리) — 최상위 폴더를 벗긴 뒤 기준", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "dist/index.html": "<p>", "dist/__ts/nav.js": "evil", "dist/pages/__ts.html": "<p>" }) });
    expect(r.ok && r.files.map((f) => f.path).sort()).toEqual(["index.html", "pages/__ts.html"]);
    expect(r.ok && r.skipped).toEqual([{ path: "__ts/nav.js", reason: "예약 경로(__ts/)" }]);
  });

  it("index.html 이 없으면 발견한 html 을 알려주며 거부", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "app.html": "<p>", "x/y.css": "a" }) });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("app.html");
  });

  it("대소문자만 다른 경로는 중복으로 거부(대소문자 무시 파일시스템에서 조용히 덮어써짐)", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "index.html": "<p>", "Assets/i.js": "1", "assets/i.js": "2" }) });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toContain("assets/i.js");
  });

  it("허용되지 않는 확장자는 목록과 함께 거부", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "index.html": "<p>", "run.sh": "rm" }) });
    expect(!r.ok && r.error).toContain("run.sh");
  });

  it("탈출 경로가 있으면 거부", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "index.html": "<p>", "../evil.js": "1" }) });
    expect(r).toMatchObject({ ok: false });
  });

  it("파일 수 상한 초과 거부", () => {
    const entries: Record<string, string> = { "index.html": "<p>" };
    for (let i = 0; i < SITE_LIMITS.files; i++) entries[`a/${i}.txt`] = "x";
    expect(validateBundle({ filename: "b.zip", data: zip(entries) })).toMatchObject({ ok: false });
  });

  it("업로드 크기 상한 초과 거부", () => {
    const big = Buffer.alloc(SITE_LIMITS.uploadBytes + 1);
    expect(validateBundle({ filename: "a.html", data: big })).toMatchObject({ ok: false });
  });

  it("index.html 의 절대경로 에셋은 경고(업로드는 허용)", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "index.html": '<script src="/assets/i.js"></script><a href="//cdn.x/y">', "assets/i.js": "1" }) });
    expect(r.ok).toBe(true);
    expect(r.ok && r.warnings.join()).toContain("/assets/i.js");
  });

  it("a.html 과 a/index.html 이 함께 있으면 같은 주소 경고(업로드는 허용)", () => {
    const r = validateBundle({
      filename: "b.zip",
      data: zip({ "index.html": "<p>", "a.html": "1", "a/index.html": "2", "docs/b.html": "3", "docs/b/index.html": "4", "c.html": "5" }),
    });
    expect(r.ok).toBe(true);
    const w = (r.ok && r.warnings.join("\n")) || "";
    expect(w).toContain("/a → a.html (a/index.html 는 가려짐)");
    expect(w).toContain("/docs/b → docs/b.html (docs/b/index.html 는 가려짐)");
    expect(w).not.toContain("c.html");
  });

  it("겹치는 쌍이 없으면 경고 없음", () => {
    const r = validateBundle({ filename: "b.zip", data: zip({ "index.html": "<p>", "a/index.html": "1", "b.html": "2" }) });
    expect(r.ok && r.warnings).toEqual([]);
  });
});

describe("mimeFor", () => {
  it("허용 확장자만 타입을 준다", () => {
    expect(mimeFor("a/b.JS")).toBe("text/javascript; charset=utf-8");
    expect(mimeFor("x.exe")).toBeNull();
    expect(mimeFor("noext")).toBeNull();
  });
});

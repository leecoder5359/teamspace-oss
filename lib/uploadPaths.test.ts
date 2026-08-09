import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import {
  cspFor,
  safeUploadSegments,
  contentTypeFor,
  dispositionFor,
  uploadRoot,
  legacyUploadRoot,
  uploadFilePath,
} from "@/lib/uploadPaths";
import { DATA_DIR } from "@/lib/dataDir";

describe("safeUploadSegments — 경로 가드", () => {
  it("정상: <workspaceId>/<파일명>", () => {
    expect(safeUploadSegments(["cmqt281yd0001", "a1b2c3-그림.png"])).toEqual({
      workspaceId: "cmqt281yd0001",
      filename: "a1b2c3-그림.png",
    });
  });

  it("칸 수가 2 가 아니면 거절", () => {
    expect(safeUploadSegments([])).toBeNull();
    expect(safeUploadSegments(["ws"])).toBeNull();
    expect(safeUploadSegments(["ws", "sub", "f.png"])).toBeNull();
  });

  it("경로 탈출·구분자·빈 칸을 거절", () => {
    expect(safeUploadSegments(["..", "f.png"])).toBeNull();
    expect(safeUploadSegments(["ws", ".."])).toBeNull();
    expect(safeUploadSegments(["ws", "../../etc/passwd"])).toBeNull();
    expect(safeUploadSegments(["ws", "a/b.png"])).toBeNull();
    expect(safeUploadSegments(["ws", "a\\b.png"])).toBeNull();
    expect(safeUploadSegments(["", "f.png"])).toBeNull();
    expect(safeUploadSegments(["ws", ""])).toBeNull();
    expect(safeUploadSegments(["ws", "."])).toBeNull();
  });

  it("제어문자·NUL 을 거절", () => {
    expect(safeUploadSegments(["ws", "a\x00.png"])).toBeNull();
    expect(safeUploadSegments(["ws", "a\n.png"])).toBeNull();
  });

  it("숨김 파일(점으로 시작)을 거절", () => {
    expect(safeUploadSegments(["ws", ".env"])).toBeNull();
  });

  it("워크스페이스 id 는 영문·숫자·하이픈만(디렉터리 이름으로 쓰인다)", () => {
    expect(safeUploadSegments(["ws id", "f.png"])).toBeNull();
    expect(safeUploadSegments(["ws/../x", "f.png"])).toBeNull();
  });
});

describe("contentTypeFor", () => {
  it("아는 확장자를 매핑한다", () => {
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("a.jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("a.gif")).toBe("image/gif");
    expect(contentTypeFor("a.webp")).toBe("image/webp");
    expect(contentTypeFor("a.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("a.pdf")).toBe("application/pdf");
    expect(contentTypeFor("a.txt")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("a.csv")).toBe("text/csv; charset=utf-8");
  });

  it("모르는 확장자·확장자 없음은 octet-stream", () => {
    expect(contentTypeFor("a.pptx")).toBe("application/octet-stream");
    expect(contentTypeFor("noext")).toBe("application/octet-stream");
  });

  it("html·js 는 절대 그 타입으로 내보내지 않는다 (같은 출처 저장형 XSS)", () => {
    expect(contentTypeFor("evil.html")).toBe("application/octet-stream");
    expect(contentTypeFor("evil.htm")).toBe("application/octet-stream");
    expect(contentTypeFor("evil.js")).toBe("application/octet-stream");
    expect(contentTypeFor("evil.mjs")).toBe("application/octet-stream");
    expect(contentTypeFor("evil.xhtml")).toBe("application/octet-stream");
  });
});

describe("dispositionFor", () => {
  it("그림·PDF 는 브라우저에서 바로 보여준다", () => {
    expect(dispositionFor("image/png")).toBe("inline");
    expect(dispositionFor("application/pdf")).toBe("inline");
  });

  it("svg 도 inline 이지만(문서에 박히므로) 라우트가 CSP 로 무력화한다", () => {
    expect(dispositionFor("image/svg+xml")).toBe("inline");
  });

  it("나머지는 받게 한다 — 브라우저가 문서로 해석할 여지를 주지 않는다", () => {
    expect(dispositionFor("application/octet-stream")).toBe("attachment");
    expect(dispositionFor("text/plain; charset=utf-8")).toBe("attachment");
    expect(dispositionFor("text/csv; charset=utf-8")).toBe("attachment");
  });
});

describe("uploadRoot / legacyUploadRoot", () => {
  const saved = process.env.TEAMSPACE_DATA_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.TEAMSPACE_DATA_DIR;
    else process.env.TEAMSPACE_DATA_DIR = saved;
  });

  // 데이터 루트는 lib/dataDir 한 곳에서만 정한다(문서·본문 저장소와 같은 출처).
  // DATA_DIR 은 모듈 로드 시점에 굳으므로 여기서는 '기본값 = <cwd>/data/uploads' 만 본다.
  it("기본은 <cwd>/data/uploads — 레포의 public/ 밖이다", () => {
    expect(uploadRoot()).toBe(path.join(process.cwd(), "data", "uploads"));
  });

  it("첨부 루트는 데이터 루트 아래 uploads 다 (자기 env 를 따로 읽지 않는다)", () => {
    expect(uploadRoot()).toBe(path.join(DATA_DIR, "uploads"));
    // UPLOAD_DIR 같은 별도 env 는 더 이상 보지 않는다 — 있어도 무시된다
    process.env.UPLOAD_DIR = "/mnt/should-be-ignored";
    expect(uploadRoot()).toBe(path.join(DATA_DIR, "uploads"));
    delete process.env.UPLOAD_DIR;
  });

  it("레거시 경로는 여전히 public/uploads (이미 올라간 파일이 그 밑에 있다)", () => {
    expect(legacyUploadRoot()).toBe(path.join(process.cwd(), "public", "uploads"));
  });
});

describe("uploadFilePath", () => {
  it("루트 아래 <ws>/<파일> 로 합친다", () => {
    expect(uploadFilePath("/srv/up", { workspaceId: "ws1", filename: "a.png" })).toBe(
      path.join("/srv/up", "ws1", "a.png"),
    );
  });

  it("합친 결과가 루트를 벗어나면 null (가드를 두 겹으로 둔다)", () => {
    expect(uploadFilePath("/srv/up", { workspaceId: "ws1", filename: "../../etc/passwd" })).toBeNull();
  });
});

describe("cspFor", () => {
  it("svg 는 sandbox 로 출처를 떼어낸다 (스크립트를 실행할 수 있는 유일한 그림 타입)", () => {
    const csp = cspFor("image/svg+xml");
    expect(csp).toContain("sandbox");
    expect(csp).toContain("default-src 'none'");
  });

  it("png·pdf 는 sandbox 를 걸지 않는다 — 내장 뷰어가 죽으면 내려받기밖에 안 남는다", () => {
    for (const t of ["image/png", "application/pdf"]) {
      const csp = cspFor(t);
      expect(csp).not.toContain("sandbox");
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("object-src 'none'");
    }
  });

  it("어느 타입이든 스크립트는 default-src 'none' 으로 막힌다", () => {
    for (const t of ["image/png", "image/svg+xml", "application/octet-stream"]) {
      expect(cspFor(t)).toContain("default-src 'none'");
    }
  });
});

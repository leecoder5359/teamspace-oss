import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip, safeZipPath } from "@/lib/zip";

const FIXED = new Date("2026-08-08T12:34:56Z");

/**
 * 이 테스트의 핵심은 "우리가 만든 바이트가 **진짜 zip 인가**" 다.
 * 자체 파서로 되읽으면 우리 실수를 우리가 확인하는 꼴이라, 시스템 unzip 으로 푼다.
 */
function unzipToDir(buf: Buffer): { dir: string; list: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ziptest-"));
  const zipPath = join(dir, "a.zip");
  writeFileSync(zipPath, buf);
  execFileSync("unzip", ["-q", "-o", zipPath, "-d", join(dir, "out")]);
  const list = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return { dir, list };
}

describe("createZip — 시스템 unzip 으로 실제 해제된다", () => {
  it("여러 파일을 담고 내용이 그대로 나온다", () => {
    const buf = createZip(
      [
        { path: "docs/a.md", data: "# 제목\n본문\n" },
        { path: "docs/nested/b.md", data: "두 번째\n" },
        { path: "manifest.json", data: JSON.stringify({ ok: true }) },
      ],
      FIXED,
    );
    const { dir, list } = unzipToDir(buf);
    try {
      expect(list.sort()).toEqual(["docs/a.md", "docs/nested/b.md", "manifest.json"]);
      expect(readFileSync(join(dir, "out", "docs/a.md"), "utf8")).toBe("# 제목\n본문\n");
      expect(readFileSync(join(dir, "out", "docs/nested/b.md"), "utf8")).toBe("두 번째\n");
      expect(JSON.parse(readFileSync(join(dir, "out", "manifest.json"), "utf8"))).toEqual({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("한글 파일명이 깨지지 않는다(UTF-8 플래그)", () => {
    // macOS 의 Info-ZIP unzip(6.0)은 UTF-8 플래그(비트 11)를 제대로 읽지 못해
    // 한글 이름을 깨뜨린다 — 우리 zip 의 문제가 아니라 그 추출기의 한계다.
    // 표준을 지키는 독립 구현(Python zipfile)으로 확인한다.
    const buf = createZip([{ path: "문서/설계 노트.md", data: "가나다\n" }], FIXED);
    const dir = mkdtempSync(join(tmpdir(), "ziptest-ko-"));
    const zipPath = join(dir, "a.zip");
    try {
      writeFileSync(zipPath, buf);
      const out = execFileSync(
        "python3",
        [
          "-c",
          [
            "import zipfile,sys,json",
            "z=zipfile.ZipFile(sys.argv[1])",
            "i=z.infolist()[0]",
            "print(json.dumps({'name':i.filename,'utf8':bool(i.flag_bits&0x800),'body':z.read(i).decode('utf-8'),'ok':z.testzip() is None}))",
          ].join("\n"),
          zipPath,
        ],
        { encoding: "utf8" },
      );
      const r = JSON.parse(out) as { name: string; utf8: boolean; body: string; ok: boolean };
      expect(r.name).toBe("문서/설계 노트.md");
      expect(r.utf8).toBe(true);
      expect(r.body).toBe("가나다\n");
      expect(r.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("큰 반복 텍스트는 압축되고, 원본이 정확히 복원된다", () => {
    const big = "같은 줄이 반복됩니다.\n".repeat(3000);
    const buf = createZip([{ path: "big.md", data: big }], FIXED);
    // 압축이 실제로 먹었는지 — 원본보다 확실히 작아야 한다
    expect(buf.length).toBeLessThan(Buffer.byteLength(big) / 5);
    const { dir } = unzipToDir(buf);
    try {
      expect(readFileSync(join(dir, "out", "big.md"), "utf8")).toBe(big);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("빈 파일·빈 목록도 유효한 zip", () => {
    const { dir } = unzipToDir(createZip([{ path: "empty.md", data: "" }], FIXED));
    try {
      expect(readFileSync(join(dir, "out", "empty.md"), "utf8")).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // 엔트리 0개도 형식상 유효해야 한다(unzip 이 빈 아카이브로 읽는다)
    const empty = createZip([], FIXED);
    expect(empty.length).toBe(22); // EOCD 만
    expect(empty.readUInt32LE(0)).toBe(0x06054b50);
  });

  it("같은 입력·같은 시각이면 바이트가 같다(결정적)", () => {
    const mk = () => createZip([{ path: "a.md", data: "x" }], FIXED);
    expect(mk().equals(mk())).toBe(true);
  });

  it("엔트리가 65535 를 넘으면 조용히 깨진 zip 대신 던진다", () => {
    const many = Array.from({ length: 65536 }, (_, i) => ({ path: `f${i}.md`, data: "x" }));
    expect(() => createZip(many, FIXED)).toThrow(/ZIP64/);
  });
});

describe("safeZipPath", () => {
  it("경로 탈출을 막는다", () => {
    expect(safeZipPath("../../etc/passwd")).toBe("etc/passwd");
    expect(safeZipPath("a/../../b")).toBe("a/b");
  });

  it("제어문자·금지문자를 치환한다", () => {
    expect(safeZipPath('a<b>c:d"e|f?g*h')).toBe("a_b_c_d_e_f_g_h");
  });

  it("빈 경로는 대체 이름을 준다", () => {
    expect(safeZipPath("")).toBe("untitled");
    expect(safeZipPath("///")).toBe("untitled");
  });

  it("정상 경로는 그대로", () => {
    expect(safeZipPath("docs/설계/노트.md")).toBe("docs/설계/노트.md");
  });
});

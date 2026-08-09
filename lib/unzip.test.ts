import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZip } from "@/lib/zip";
import { readZip } from "@/lib/unzip";

const FIXED = new Date("2026-08-09T01:02:03Z");

/**
 * 우리 createZip 으로 만든 걸 우리 readZip 으로 읽는 건 **우리 실수를 우리가 확인하는 꼴**이다.
 * 그래서 반대편 fixture 는 Python zipfile(표준 독립 구현)로 만들어 넣는다.
 * zip.test.ts 가 쓰기 방향에서 한 것과 같은 대칭 전략.
 */
function pythonZip(script: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "unziptest-"));
  const zipPath = join(dir, "a.zip");
  try {
    execFileSync("python3", ["-c", ["import zipfile,sys", "p=sys.argv[1]", script].join("\n"), zipPath]);
    return readFileSync(zipPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const text = (b: Buffer) => b.toString("utf8");

describe("readZip — Python zipfile 이 만든 zip 을 읽는다", () => {
  it("deflate 로 압축된 엔트리를 푼다", () => {
    const buf = pythonZip(
      [
        "z=zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED)",
        "z.writestr('docs/a.md','# 제목\\n같은 줄\\n'*200)",
        "z.writestr('b.md','짧다')",
        "z.close()",
      ].join("\n"),
    );
    const entries = readZip(buf);
    expect(entries.map((e) => e.path)).toEqual(["docs/a.md", "b.md"]);
    expect(text(entries[0].data)).toBe("# 제목\n같은 줄\n".repeat(200));
    expect(text(entries[1].data)).toBe("짧다");
  });

  it("무압축(store) 엔트리도 읽는다", () => {
    const buf = pythonZip(["z=zipfile.ZipFile(p,'w',zipfile.ZIP_STORED)", "z.writestr('a.md','그대로')", "z.close()"].join("\n"));
    expect(text(readZip(buf)[0].data)).toBe("그대로");
  });

  it("한글 파일명이 깨지지 않는다", () => {
    const buf = pythonZip(
      ["z=zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED)", "z.writestr('문서/설계 노트.md','가나다')", "z.close()"].join("\n"),
    );
    const e = readZip(buf)[0];
    expect(e.path).toBe("문서/설계 노트.md");
    expect(text(e.data)).toBe("가나다");
  });

  it("디렉터리 엔트리는 건너뛴다", () => {
    // 실제 폴더를 zip 하면(zip -r, Finder 압축) 디렉터리 엔트리가 함께 들어온다.
    const buf = pythonZip(
      [
        "z=zipfile.ZipFile(p,'w',zipfile.ZIP_DEFLATED)",
        "z.writestr('folder/','')",
        "z.writestr('folder/a.md','내용')",
        "z.close()",
      ].join("\n"),
    );
    expect(readZip(buf).map((e) => e.path)).toEqual(["folder/a.md"]);
  });

  it("빈 파일도 엔트리로 나온다", () => {
    const buf = pythonZip(["z=zipfile.ZipFile(p,'w')", "z.writestr('empty.md','')", "z.close()"].join("\n"));
    const entries = readZip(buf);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.length).toBe(0);
  });

  it("아카이브 주석이 붙어 있어도 EOCD 를 찾는다", () => {
    const buf = pythonZip(
      [
        "z=zipfile.ZipFile(p,'w')",
        "z.writestr('a.md','본문')",
        "z.comment=b'made by something else'",
        "z.close()",
      ].join("\n"),
    );
    expect(text(readZip(buf)[0].data)).toBe("본문");
  });
});

describe("readZip — 우리 createZip 과 왕복한다", () => {
  it("쓰고 읽으면 원본이 그대로 나온다", () => {
    const entries = [
      { path: "docs/프로젝트/노트.md", data: "# 노트\n\n본문\n" },
      { path: "workspace.json", data: JSON.stringify({ ok: true }) },
      { path: "big.md", data: "반복\n".repeat(5000) }, // deflate 경로
      { path: "empty.md", data: "" },
    ];
    const round = readZip(createZip(entries, FIXED));
    expect(round.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    for (let i = 0; i < entries.length; i++) expect(text(round[i].data)).toBe(entries[i].data);
  });

  it("엔트리가 0개인 zip 은 빈 배열", () => {
    expect(readZip(createZip([], FIXED))).toEqual([]);
  });
});

describe("readZip — 깨진 입력에는 조용히 실패하지 않는다", () => {
  it("zip 이 아니면 던진다", () => {
    expect(() => readZip(Buffer.from("이건 zip 이 아니다"))).toThrow(/zip/i);
  });

  it("중앙 디렉터리가 잘리면 던진다", () => {
    const buf = createZip([{ path: "a.md", data: "x" }], FIXED);
    expect(() => readZip(buf.subarray(0, buf.length - 30))).toThrow();
  });

  it("본문이 손상되면(CRC 불일치) 던진다", () => {
    const buf = Buffer.from(createZip([{ path: "a.md", data: "원본 내용입니다" }], FIXED));
    // local header(30) + name(4) 뒤 첫 바이트를 뒤집는다
    buf[30 + 4] ^= 0xff;
    expect(() => readZip(buf)).toThrow(/손상|CRC/i);
  });

  it("엔트리 수 상한을 넘으면 던진다", () => {
    const buf = createZip(
      Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.md`, data: "x" })),
      FIXED,
    );
    expect(() => readZip(buf, { maxEntries: 3 })).toThrow(/엔트리/);
  });

  it("압축 해제 총량 상한을 넘으면 던진다(zip bomb 방어)", () => {
    // 압축률이 매우 높은 입력 — 압축 크기는 작지만 풀면 크다
    const buf = createZip([{ path: "bomb.md", data: "a".repeat(200_000) }], FIXED);
    expect(buf.length).toBeLessThan(5_000);
    expect(() => readZip(buf, { maxTotalBytes: 100_000 })).toThrow(/너무 큽니다|상한/);
  });
});

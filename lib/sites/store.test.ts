import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVersion, resolveSiteFile, resolveShellFile, versionDir, removeVersionDir, versionsToPrune } from "./store";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "sites-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("writeVersion / resolveSiteFile", () => {
  it("파일을 v<n> 에 쓰고 경로로 되찾는다", async () => {
    await writeVersion(root, "cabc123", 1, [
      { path: "index.html", data: Buffer.from("<p>") },
      { path: "assets/a.css", data: Buffer.from("b{}") },
    ]);
    const f = resolveSiteFile(root, "cabc123", 1, ["assets", "a.css"]);
    expect(f).toBe(join(versionDir(root, "cabc123", 1), "assets", "a.css"));
    expect(await readFile(f!, "utf8")).toBe("b{}");
    // 임시 폴더가 남지 않는다
    expect((await readdir(join(root, "cabc123"))).filter((n) => n.startsWith(".tmp"))).toEqual([]);
  });

  it("같은 버전을 다시 쓰면 실패하고 임시 폴더를 치운다", async () => {
    const files = [{ path: "index.html", data: Buffer.from("1") }];
    await writeVersion(root, "cabc123", 1, files);
    await expect(writeVersion(root, "cabc123", 1, files)).rejects.toThrow();
    expect((await readdir(join(root, "cabc123"))).filter((n) => n.startsWith(".tmp"))).toEqual([]);
  });

  it("탈출·숨김·잘못된 id·버전은 null", () => {
    expect(resolveSiteFile(root, "cabc123", 1, ["..", "..", "etc", "passwd"])).toBeNull();
    expect(resolveSiteFile(root, "cabc123", 1, [".env"])).toBeNull();
    expect(resolveSiteFile(root, "../x", 1, ["index.html"])).toBeNull();
    expect(resolveSiteFile(root, "cabc123", 0, ["index.html"])).toBeNull();
  });

  it("removeVersionDir 은 그 버전만 지운다", async () => {
    await writeVersion(root, "cabc123", 1, [{ path: "index.html", data: Buffer.from("1") }]);
    await writeVersion(root, "cabc123", 2, [{ path: "index.html", data: Buffer.from("2") }]);
    await removeVersionDir(root, "cabc123", 1);
    expect((await readdir(join(root, "cabc123"))).sort()).toEqual(["v2"]);
  });
});

describe("versionsToPrune", () => {
  it("최신 keep 개와 current 는 남긴다", () => {
    expect(versionsToPrune([1, 2, 3, 4, 5], 5, 3)).toEqual([1, 2]);
    expect(versionsToPrune([1, 2, 3, 4, 5], 1, 3)).toEqual([2]);
    expect(versionsToPrune([1, 2], 2, 10)).toEqual([]);
  });
});

describe("resolveShellFile — 셸 하위 경로 → 현재 버전의 실제 파일", () => {
  beforeEach(async () => {
    await writeVersion(root, "cabc123", 1, [
      { path: "index.html", data: Buffer.from("<p>") },
      { path: "pages/supabase-setup.html", data: Buffer.from("<p>") },
      { path: "docs/index.html", data: Buffer.from("<p>") },
      { path: "both.html", data: Buffer.from("<p>") },
      { path: "both/index.html", data: Buffer.from("<p>") },
      { path: "old.htm", data: Buffer.from("<p>") },
    ]);
  });
  it("'' → index.html, a/b → a/b.html, 없으면 a/b/index.html", async () => {
    expect(await resolveShellFile(root, "cabc123", 1, [])).toBe("index.html");
    expect(await resolveShellFile(root, "cabc123", 1, ["pages", "supabase-setup"])).toBe("pages/supabase-setup.html");
    expect(await resolveShellFile(root, "cabc123", 1, ["docs"])).toBe("docs/index.html");
    expect(await resolveShellFile(root, "cabc123", 1, ["both"])).toBe("both.html");
  });
  it("이미 .html·.htm 이면 그대로", async () => {
    expect(await resolveShellFile(root, "cabc123", 1, ["pages", "supabase-setup.html"])).toBe("pages/supabase-setup.html");
    expect(await resolveShellFile(root, "cabc123", 1, ["old.htm"])).toBe("old.htm");
  });
  it("없는 파일·디렉터리·다른 버전 → null", async () => {
    expect(await resolveShellFile(root, "cabc123", 1, ["nope"])).toBeNull();
    expect(await resolveShellFile(root, "cabc123", 1, ["pages"])).toBeNull();
    expect(await resolveShellFile(root, "cabc123", 2, [])).toBeNull();
  });
  it("경로 이탈·숨김·예약 폴더는 null", async () => {
    for (const bad of [[".."], ["..", "..", "etc", "passwd"], ["pages", "..", "..", "x"], [".git"], ["__ts", "nav.js"], ["a\\..\\b"]]) {
      expect(await resolveShellFile(root, "cabc123", 1, bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

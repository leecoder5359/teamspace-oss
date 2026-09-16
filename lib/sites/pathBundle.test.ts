import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip } from "@/lib/unzip";
import { bundleFromPath } from "./pathBundle";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pb-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("bundleFromPath", () => {
  it("파일은 그대로 읽는다", () => {
    writeFileSync(join(dir, "r.html"), "<p>");
    expect(bundleFromPath(join(dir, "r.html"))).toEqual({ filename: "r.html", data: Buffer.from("<p>") });
  });

  it("폴더는 zip 으로 묶고 숨김 파일·node_modules 는 뺀다", () => {
    mkdirSync(join(dir, "site", "assets"), { recursive: true });
    writeFileSync(join(dir, "site", "index.html"), "<p>");
    writeFileSync(join(dir, "site", "assets", "a.css"), "b{}");
    writeFileSync(join(dir, "site", ".env"), "SECRET=1");
    mkdirSync(join(dir, "site", "node_modules"));
    writeFileSync(join(dir, "site", "node_modules", "x.js"), "1");
    const b = bundleFromPath(join(dir, "site"));
    expect(b.filename).toBe("site.zip");
    expect(readZip(b.data).map((e) => e.path).sort()).toEqual(["assets/a.css", "index.html"]);
  });

  it("없는 경로는 에러", () => {
    expect(() => bundleFromPath(join(dir, "nope"))).toThrow();
  });
});

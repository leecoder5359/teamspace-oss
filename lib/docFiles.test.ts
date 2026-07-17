import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  DOCS_ROOT,
  resolveDocPath,
  slugify,
  uniqueFileName,
  readDoc,
  writeDoc,
  docFolderFor,
} from "@/lib/docFiles";

// ── resolveDocPath ─────────────────────────────────────────────────────────

describe("resolveDocPath", () => {
  it("returns absolute path under DOCS_ROOT for a valid relative .md path", () => {
    const result = resolveDocPath("teamspace/PROGRESS.md");
    expect(result).toBe(path.join(DOCS_ROOT, "teamspace", "PROGRESS.md"));
    expect(result.startsWith(DOCS_ROOT + path.sep)).toBe(true);
  });

  it("throws on '../' traversal escape", () => {
    expect(() => resolveDocPath("../secret.md")).toThrow();
  });

  it("throws on absolute path escape (/etc/passwd)", () => {
    expect(() => resolveDocPath("/etc/passwd")).toThrow();
  });

  it("throws when resolved path is not .md", () => {
    expect(() => resolveDocPath("foo.txt")).toThrow();
  });

  it("throws on deep traversal that escapes DOCS_ROOT (teamspace/../../x.md)", () => {
    expect(() => resolveDocPath("teamspace/../../x.md")).toThrow();
  });

  it("allows a nested valid path", () => {
    const result = resolveDocPath("a/b/c.md");
    expect(result).toBe(path.join(DOCS_ROOT, "a", "b", "c.md"));
  });
});

// ── slugify ───────────────────────────────────────────────────────────────

describe("slugify", () => {
  it('lowercases ASCII and replaces spaces with hyphen: "My Project" -> "my-project"', () => {
    expect(slugify("My Project")).toBe("my-project");
  });

  it("keeps Korean (Hangul) characters as-is and replaces spaces", () => {
    expect(slugify("아키텍처 문서")).toBe("아키텍처-문서");
  });

  it("strips filesystem-unsafe chars (/ \\ : * ? \" < > |)", () => {
    // "a/b:c?.md title" -> "abc-md-title" (slash, colon, ? removed; . removed; space->hyphen)
    const result = slugify('a/b:c?.md title');
    expect(result).not.toMatch(/[/\\:*?"<>|]/);
    // should start with 'a' and contain 'title'
    expect(result).toMatch(/^a/);
    expect(result).toContain("title");
  });

  it('returns "untitled" for empty string', () => {
    expect(slugify("")).toBe("untitled");
  });

  it('returns "untitled" for whitespace-only string', () => {
    expect(slugify("   ")).toBe("untitled");
  });

  it("collapses multiple spaces into a single hyphen", () => {
    expect(slugify("hello   world")).toBe("hello-world");
  });

  it("collapses multiple hyphens", () => {
    expect(slugify("hello---world")).toBe("hello-world");
  });

  it("strips leading and trailing dots/hyphens", () => {
    const result = slugify("--hello world--");
    expect(result).toBe("hello-world");
  });

  it("mixed Korean + ASCII", () => {
    expect(slugify("Project 설계 Plan")).toBe("project-설계-plan");
  });

  it("strips emoji and keeps Korean: '📋 로드맵' -> '로드맵'", () => {
    expect(slugify("📋 로드맵")).toBe("로드맵");
  });

  it("strips em-dash, parens, plus: 'M2 — DB+뷰 (태스크 보드)' -> 'm2-db뷰-태스크-보드'", () => {
    expect(slugify("M2 — DB+뷰 (태스크 보드)")).toBe("m2-db뷰-태스크-보드");
  });

  it("returns 'untitled' for emoji-only input", () => {
    expect(slugify("📋🎯🚀")).toBe("untitled");
  });
});

// ── uniqueFileName ────────────────────────────────────────────────────────

describe("uniqueFileName", () => {
  it("returns <slug>.md when no collision", () => {
    expect(uniqueFileName([], "My Project")).toBe("my-project.md");
  });

  it("returns <slug>-2.md on first collision", () => {
    expect(uniqueFileName(["my-project.md"], "My Project")).toBe("my-project-2.md");
  });

  it("returns <slug>-3.md on double collision", () => {
    expect(uniqueFileName(["my-project.md", "my-project-2.md"], "My Project")).toBe(
      "my-project-3.md"
    );
  });

  it("collision check is case-insensitive", () => {
    expect(uniqueFileName(["My-Project.md"], "My Project")).toBe("my-project-2.md");
  });

  it("no collision even with mixed case in existing list", () => {
    expect(uniqueFileName(["OTHER.md", "ANOTHER.md"], "My Project")).toBe("my-project.md");
  });
});

// ── docFolderFor ──────────────────────────────────────────────────────────

describe("docFolderFor", () => {
  it("returns docsDir when set (wins over name)", () => {
    expect(docFolderFor({ docsDir: "myproject", name: "Other Name" })).toBe("myproject");
  });

  it("falls back to slugify(name) when docsDir is null", () => {
    expect(docFolderFor({ docsDir: null, name: "Team Space" })).toBe("team-space");
  });

  it("falls back to slugify(name) when docsDir is undefined", () => {
    expect(docFolderFor({ name: "아키텍처" })).toBe("아키텍처");
  });

  it("returns '_inbox' when project is null", () => {
    expect(docFolderFor(null)).toBe("_inbox");
  });

  it("returns '_inbox' when project is undefined", () => {
    expect(docFolderFor(undefined)).toBe("_inbox");
  });

  it("returns '_inbox' when both docsDir and name are null", () => {
    expect(docFolderFor({ docsDir: null, name: null })).toBe("_inbox");
  });
});

// ── readDoc / writeDoc round-trip (stays inside DOCS_ROOT) ───────────────

const TEST_REL = "__vitest__/round-trip.md";
const TEST_CONTENT = "# Round-trip\n\nHello from tests.\n";

describe("readDoc / writeDoc", () => {
  afterAll(async () => {
    // cleanup: remove the test file and its parent dir
    try {
      await fs.rm(path.join(DOCS_ROOT, "__vitest__"), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("writeDoc creates the file and readDoc reads it back", async () => {
    await writeDoc(TEST_REL, TEST_CONTENT);
    const content = await readDoc(TEST_REL);
    expect(content).toBe(TEST_CONTENT);
  });

  it("readDoc returns empty string for a non-existent file", async () => {
    const content = await readDoc("__vitest__/does-not-exist.md");
    expect(content).toBe("");
  });

  it("writeDoc / readDoc reject paths outside DOCS_ROOT", async () => {
    await expect(writeDoc("../escape.md", "x")).rejects.toThrow();
    await expect(readDoc("../escape.md")).rejects.toThrow();
  });
});

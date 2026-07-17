/**
 * Migration script: move existing DOC page bodies from the old scheme
 * (content/<workspaceId>/<pageId>.md  /  Page.markdown column cache)
 * to human-readable files under docs/<folder>/<slug>.md, and update
 * Page.filePath to the new docs-root-relative path.
 *
 * Usage:
 *   # Dry-run (default — safe, no writes, no DB changes):
 *   pnpm exec tsx scripts/migrate-docs-to-files.ts
 *
 *   # Apply (writes files and updates DB):
 *   pnpm exec tsx scripts/migrate-docs-to-files.ts --apply
 *
 * The script is IDEMPOTENT: pages already pointing to an existing file
 * under docs/ are skipped without error.
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  DOCS_ROOT,
  resolveDocPath,
  docFolderFor,
  listDocFolder,
  uniqueFileName,
  writeDoc,
  readDoc,
} from "../lib/docFiles";
import { CONTENT_DIR, readContent } from "../lib/content";

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------
const DRY_RUN = !process.argv.includes("--apply");

// ---------------------------------------------------------------------------
// Prisma client (same pattern as prisma/seed.ts)
// ---------------------------------------------------------------------------
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if abs path exists on disk. */
async function fileExists(abs: string): Promise<boolean> {
  return fs.access(abs).then(() => true).catch(() => false);
}

/** Returns true if this page's filePath already points to a live docs/ file. */
async function isAlreadyMigrated(filePath: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    const abs = resolveDocPath(filePath);
    return await fileExists(abs);
  } catch {
    // resolveDocPath threw → not a valid docs/ path
    return false;
  }
}

/**
 * Read the body for a page that has NOT yet been migrated.
 * Priority:
 *   1. content/<filePath> file if it exists
 *   2. page.markdown column (may be null)
 *   3. empty string
 */
async function readOldBody(
  filePath: string | null,
  markdown: string | null,
): Promise<string> {
  if (filePath) {
    const contentAbs = path.resolve(CONTENT_DIR, filePath);
    if (await fileExists(contentAbs)) {
      return readContent(filePath);
    }
  }
  return markdown ?? "";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const divider = "=".repeat(64);

  if (DRY_RUN) {
    console.log(divider);
    console.log("  DRY-RUN MODE — no files written, no DB changes.");
    console.log("  Pass --apply to actually migrate.");
    console.log(divider);
  } else {
    console.log(divider);
    console.log("  APPLY MODE — files will be written and DB will be updated.");
    console.log(divider);
  }

  // 1. Load all non-deleted doc pages with their project relation
  const pages = await prisma.page.findMany({
    where: { kind: "doc", deletedAt: null },
    select: {
      id: true,
      title: true,
      filePath: true,
      markdown: true,
      project: {
        select: { name: true, docsDir: true },
      },
    },
  });

  console.log(`\nFound ${pages.length} doc page(s) to process.\n`);

  // Track filenames already allocated THIS run per folder (in-memory dedup).
  // This prevents two pages with the same title in the same folder from
  // receiving identical filenames before either one is flushed to disk.
  const allocatedPerFolder = new Map<string, Set<string>>();

  let migratedCount = 0;
  let skippedCount = 0;
  const errorMessages: string[] = [];

  interface TableRow {
    title: string;
    relPath: string;
    status: string;
  }
  const table: TableRow[] = [];

  // 2. Process each page
  for (const page of pages) {
    const label = `[Page ${page.id.slice(-8)} "${page.title}"]`;

    // --- Skip check ----------------------------------------------------------
    if (await isAlreadyMigrated(page.filePath)) {
      console.log(`  SKIP  ${label} (already migrated → ${page.filePath})`);
      skippedCount++;
      table.push({ title: page.title, relPath: page.filePath!, status: "skipped" });
      continue;
    }

    // --- Read old body -------------------------------------------------------
    const body = await readOldBody(page.filePath, page.markdown);

    // --- Derive new path -----------------------------------------------------
    const folder = docFolderFor(page.project);

    if (!allocatedPerFolder.has(folder)) {
      allocatedPerFolder.set(folder, new Set());
    }
    const allocated = allocatedPerFolder.get(folder)!;

    const existingOnDisk = await listDocFolder(folder);
    // Combine on-disk files with names already reserved this run
    const existingAll = [...existingOnDisk, ...Array.from(allocated)];

    const filename = uniqueFileName(existingAll, page.title);
    const relPath = `${folder}/${filename}`;
    // Reserve so the next page in this folder won't collide
    allocated.add(filename);

    // --- Dry-run short-circuit -----------------------------------------------
    if (DRY_RUN) {
      console.log(`  WOULD ${label} → ${relPath}  (${body.length} bytes)`);
      table.push({ title: page.title, relPath, status: "would migrate" });
      migratedCount++;
      continue;
    }

    // --- Write file ----------------------------------------------------------
    try {
      await writeDoc(relPath, body);
    } catch (err) {
      const msg = `${label} WRITE FAILED: ${String(err)}`;
      console.error(`  ERROR ${msg}`);
      errorMessages.push(msg);
      table.push({ title: page.title, relPath, status: "error: write failed" });
      continue;
    }

    // --- Verify byte equality ------------------------------------------------
    const written = await readDoc(relPath);
    if (written !== body) {
      // Safety: attempt to remove the bad file so re-runs don't false-skip
      await fs.unlink(path.join(DOCS_ROOT, relPath)).catch(() => undefined);
      const msg = `${label} VERIFY FAILED: byte mismatch after write to ${relPath}`;
      console.error(`  ERROR ${msg}`);
      errorMessages.push(msg);
      table.push({ title: page.title, relPath, status: "error: verify failed" });
      continue;
    }

    // --- Update DB -----------------------------------------------------------
    await prisma.page.update({
      where: { id: page.id },
      data: { filePath: relPath },
    });

    console.log(`  OK    ${label} → ${relPath}`);
    migratedCount++;
    table.push({ title: page.title, relPath, status: "migrated" });
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n" + divider);
  console.log(DRY_RUN ? "  DRY-RUN SUMMARY" : "  MIGRATION SUMMARY");
  console.log(divider);
  console.log(`  Total pages processed : ${pages.length}`);
  if (DRY_RUN) {
    console.log(`  Would migrate         : ${migratedCount}`);
  } else {
    console.log(`  Migrated              : ${migratedCount}`);
  }
  console.log(`  Skipped (already done): ${skippedCount}`);
  console.log(`  Errors                : ${errorMessages.length}`);

  if (table.length > 0) {
    const sep = "-".repeat(80);
    console.log(`\n  Title${" ".repeat(33)}  Status           → Path`);
    console.log(`  ${sep}`);
    for (const row of table) {
      const t = row.title.slice(0, 36).padEnd(36);
      const s = row.status.padEnd(14);
      console.log(`  ${t}  ${s} → ${row.relPath}`);
    }
  }

  if (errorMessages.length > 0) {
    console.log("\n  Errors detail:");
    errorMessages.forEach((e) => console.error(`    ${e}`));
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("\n  ** DRY-RUN complete. No changes were made. **");
    console.log("  ** Pass --apply to execute the migration.  **");
  } else {
    console.log("\n  ** Migration complete. **");
  }
}

main()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

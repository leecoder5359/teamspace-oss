import { promises as fs } from "node:fs";
import path from "node:path";
import { DATA_DIR, ensureDataDirs } from "@/lib/dataDir";

// docs/ は DATA_DIR (기본 <cwd>/data, env TEAMSPACE_DATA_DIR) 아래에 둔다 (Phase 2 file-first docs)
export const DOCS_ROOT = path.join(DATA_DIR, "docs");

/**
 * PURE path guard.
 * relPath を DOCS_ROOT に対して解決し、
 *   - DOCS_ROOT の外に出る場合 (../ / 絶対パス等) → throw
 *   - .md 拡張子でない場合 → throw
 * 問題なければ絶対パスを返す。
 */
export function resolveDocPath(relPath: string): string {
  const abs = path.resolve(DOCS_ROOT, relPath);
  // content.ts の absPath() と同じプレフィックスチェック方式
  if (!abs.startsWith(DOCS_ROOT + path.sep)) {
    throw new Error(`Invalid doc path (outside DOCS_ROOT): ${relPath}`);
  }
  if (!abs.endsWith(".md")) {
    throw new Error(`Doc path must end with .md: ${relPath}`);
  }
  return abs;
}

/**
 * PURE.
 * タイトル文字列から人間が読みやすいファイル名ステム (拡張子なし) を生成する。
 * ルール (ホワイトリスト方式):
 *   - trim
 *   - ASCII 大文字 → 小文字
 *   - em-dash / en-dash 等のダッシュ類 → ハイフン
 *   - 空白の連続 → ハイフン 1 個
 *   - ホワイトリスト外の文字をすべて除去
 *     (保持: Hangul 音節・字母, ASCII 英数字, ハイフン)
 *     (除去: 絵文字, 括弧類, +/=/&/@/#等の記号, FS 安全でない文字, 制御文字 など)
 *   - 連続ハイフンを折り畳む
 *   - 先頭・末尾のドット・ハイフンを除去
 *   - 結果が空なら "untitled"
 */
export function slugify(title: string): string {
  let s = title.trim();
  // ASCII 大文字を小文字に
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  // em-dash (—), en-dash (–), figure dash, minus-sign 等 → ハイフン
  s = s.replace(/[–—―−﹘﹣－]/g, "-");
  // 空白の連続をハイフンに
  s = s.replace(/\s+/g, "-");
  // ホワイトリスト外をすべて除去:
  //   保持 = 가-힣 (Hangul syllables) + ᄀ-ᇿ (Hangul Jamo) +
  //           ㄰-㆏ (Hangul Compat Jamo) + a-z + 0-9 + hyphen
  s = s.replace(/[^가-힣ᄀ-ᇿ㄰-㆏a-z0-9\-]/g, "");
  // 連続ハイフンを 1 個に
  s = s.replace(/-{2,}/g, "-");
  // 先頭・末尾のドット / ハイフンを除去
  s = s.replace(/^[.\-]+|[.\-]+$/g, "");
  return s || "untitled";
}

/**
 * PURE.
 * existing (既存ファイル名一覧) に対して衝突しないファイル名を返す。
 * 衝突チェックは大文字小文字を無視する。
 * 形式: "<slug>.md" → "<slug>-2.md" → "<slug>-3.md" → …
 */
export function uniqueFileName(existing: string[], title: string): string {
  const slug = slugify(title);
  const existingLower = existing.map((f) => f.toLowerCase());

  const candidate = `${slug}.md`;
  if (!existingLower.includes(candidate.toLowerCase())) return candidate;

  for (let n = 2; ; n++) {
    const next = `${slug}-${n}.md`;
    if (!existingLower.includes(next.toLowerCase())) return next;
  }
}

/**
 * IO: ファイルを UTF-8 で読む。存在しない場合は "" を返す。
 * git commit は行わない (Phase 2 docs はコードと同様に手動コミット)。
 */
export async function readDoc(relPath: string): Promise<string> {
  await ensureDataDirs();
  try {
    return await fs.readFile(resolveDocPath(relPath), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/**
 * IO: 親ディレクトリを再帰的に作成してからファイルを UTF-8 で書く。
 * git commit は行わない。
 */
export async function writeDoc(relPath: string, md: string): Promise<void> {
  await ensureDataDirs();
  const abs = resolveDocPath(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // 원자적 쓰기: tmp 파일 후 rename — 크래시 시 반쪽 파일 방지 (감사 doc-16)
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, md, "utf8");
  await fs.rename(tmp, abs);
}

/**
 * PURE.
 * プロジェクトの docs サブフォルダ名を返す。
 * 優先順: project.docsDir → slugify(project.name) → "_inbox"
 */
export function docFolderFor(
  project: { docsDir?: string | null; name?: string | null } | null | undefined,
): string {
  if (project?.docsDir) return project.docsDir;
  if (project?.name) return slugify(project.name);
  return "_inbox";
}

/**
 * IO: DOCS_ROOT/<folder> 内の .md ファイル名一覧を返す。
 * フォルダが存在しない場合は [] を返す (ENOENT 許容)。
 */
export async function listDocFolder(folder: string): Promise<string[]> {
  await ensureDataDirs();
  const abs = path.resolve(DOCS_ROOT, folder);
  // フォルダが DOCS_ROOT の外に出ないよう検証
  if (!abs.startsWith(DOCS_ROOT + path.sep)) {
    throw new Error(`Invalid folder path (outside DOCS_ROOT): ${folder}`);
  }
  try {
    const entries = await fs.readdir(abs);
    return entries.filter((f) => f.endsWith(".md"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DATA_DIR, ensureDataDirs } from "@/lib/dataDir";

const pexecFile = promisify(execFile);

// content/ 는 독립 git 레포 (문서 본문의 소스오브트루스) — DATA_DIR 아래에 산다.
// git 레포 초기화는 ensureDataDirs() 가 보장한다.
export const CONTENT_DIR = path.join(DATA_DIR, "content");

/** workspaceId/pageId.md 형태의 상대 경로 생성 */
export function pageFilePath(workspaceId: string, pageId: string): string {
  return path.join(workspaceId, `${pageId}.md`);
}

function absPath(relPath: string): string {
  // 경로 탈출 방지
  const abs = path.resolve(CONTENT_DIR, relPath);
  if (!abs.startsWith(CONTENT_DIR + path.sep)) {
    throw new Error(`Invalid content path: ${relPath}`);
  }
  return abs;
}

/** md 파일 읽기. 없으면 빈 문자열 */
export async function readContent(relPath: string): Promise<string> {
  await ensureDataDirs();
  try {
    return await fs.readFile(absPath(relPath), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

async function gitCommit(relPath: string, message: string): Promise<void> {
  try {
    await pexecFile("git", ["add", relPath], { cwd: CONTENT_DIR });
    await pexecFile("git", ["commit", "-q", "-m", message], { cwd: CONTENT_DIR });
  } catch (e) {
    // 변경 없음("nothing to commit")은 무시
    const msg = String((e as { stdout?: string; stderr?: string }).stdout ?? "") +
      String((e as { stderr?: string }).stderr ?? "");
    if (/nothing to commit|no changes added/i.test(msg)) return;
    throw e;
  }
}

/** md 파일 쓰기 + content 레포에 커밋 */
export async function writeContent(
  relPath: string,
  markdown: string,
  message: string,
): Promise<void> {
  await ensureDataDirs();
  const abs = absPath(relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, markdown, "utf8");
  await gitCommit(relPath, message);
}

/** md 파일 삭제 + 커밋 */
export async function deleteContent(relPath: string, message: string): Promise<void> {
  await ensureDataDirs();
  const abs = absPath(relPath);
  try {
    await fs.unlink(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await gitCommit(relPath, message);
}

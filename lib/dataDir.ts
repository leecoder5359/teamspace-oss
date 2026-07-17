import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/**
 * 데이터 루트 — 문서(docs)·본문 저장소(content)·업로드(uploads)가 이 아래에 산다.
 * 기본값은 <cwd>/data, 환경변수 TEAMSPACE_DATA_DIR 로 오버라이드.
 */
export const DATA_DIR = process.env.TEAMSPACE_DATA_DIR
  ? path.resolve(process.env.TEAMSPACE_DATA_DIR)
  : path.join(process.cwd(), "data");

let ensured: Promise<void> | null = null;

/**
 * data/docs·data/content·data/uploads 디렉토리를 보장하고
 * content 는 git 레포로 초기화한다. 프로세스당 1회만 실제 수행 (idempotent).
 */
export function ensureDataDirs(): Promise<void> {
  ensured ??= (async () => {
    const docs = path.join(DATA_DIR, "docs");
    const content = path.join(DATA_DIR, "content");
    const uploads = path.join(DATA_DIR, "uploads");
    await fs.mkdir(docs, { recursive: true });
    await fs.mkdir(content, { recursive: true });
    await fs.mkdir(uploads, { recursive: true });
    try {
      await fs.access(path.join(content, ".git"));
    } catch {
      await pexecFile("git", ["init"], { cwd: content });
    }
  })();
  return ensured;
}

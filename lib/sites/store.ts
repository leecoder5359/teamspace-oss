import path from "node:path";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";
import { normalizeBundlePath, type BundleFile } from "./bundle";
import { shellFileCandidates } from "./shellPath";

/* 퍼블리시 파일 저장소: DATA_DIR/sites/<siteId>/v<n>/…
   쓰기는 임시 폴더 → rename 으로 원자적. 반쯤 쓰인 버전이 서빙되지 않게 한다.
   읽기 경로는 resolveSiteFile 하나로만 만든다(경로 가드 단일화). */

const ID_RE = /^[a-z0-9]+$/;

export function sitesRoot(): string {
  return path.join(DATA_DIR, "sites");
}

export function versionDir(root: string, siteId: string, version: number): string {
  return path.join(root, siteId, `v${version}`);
}

function isInside(base: string, full: string): boolean {
  const rel = path.relative(base, full);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export async function writeVersion(root: string, siteId: string, version: number, files: BundleFile[]): Promise<void> {
  if (!ID_RE.test(siteId)) throw new Error(`잘못된 사이트 id: ${siteId}`);
  const siteDir = path.join(root, siteId);
  await fs.mkdir(siteDir, { recursive: true });
  const target = versionDir(root, siteId, version);
  const tmp = path.join(siteDir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await fs.access(target).then(
      () => { throw new Error(`이미 있는 버전입니다: v${version}`); },
      () => undefined,
    );
    for (const f of files) {
      const dest = path.join(tmp, ...f.path.split("/"));
      if (!isInside(tmp, dest)) throw new Error(`경로 이탈: ${f.path}`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.data);
    }
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw e;
  }
}

export async function removeVersionDir(root: string, siteId: string, version: number): Promise<void> {
  if (!ID_RE.test(siteId)) return;
  await fs.rm(versionDir(root, siteId, version), { recursive: true, force: true });
}

export function resolveSiteFile(root: string, siteId: string, version: number, segments: string[]): string | null {
  if (!ID_RE.test(siteId) || !Number.isInteger(version) || version < 1) return null;
  const rel = normalizeBundlePath(segments.join("/"));
  if (!rel || rel.split("/").some((s) => s.startsWith("."))) return null;
  const base = versionDir(root, siteId, version);
  const full = path.join(base, ...rel.split("/"));
  return isInside(base, full) ? full : null;
}

/** 셸 주소의 하위 경로(디코딩된 세그먼트) → 현재 버전에 실제로 있는 파일의 번들 상대경로.
    후보 순서는 lib/sites/shellPath.shellFileCandidates. 이탈·없는 파일은 null(셸 404). */
export async function resolveShellFile(root: string, siteId: string, version: number, segments: string[]): Promise<string | null> {
  const candidates = shellFileCandidates(segments);
  if (!candidates) return null;
  for (const rel of candidates) {
    const full = resolveSiteFile(root, siteId, version, rel.split("/"));
    if (!full) continue;
    const st = await fs.stat(full).catch(() => null);
    if (st?.isFile()) return rel;
  }
  return null;
}

export function versionsToPrune(versions: number[], current: number, keep: number): number[] {
  const newest = [...versions].sort((a, b) => b - a).slice(0, keep);
  return versions.filter((v) => v !== current && !newest.includes(v)).sort((a, b) => a - b);
}

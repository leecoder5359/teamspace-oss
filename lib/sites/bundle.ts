import { readZip } from "@/lib/unzip";
import { RESERVED_SITE_DIR, ambiguousShellPaths } from "./shellPath";

/* =====================================================================
   퍼블리시 번들 검증 — 신뢰할 수 없는 업로드를 저장 가능한 파일 목록으로 바꾼다.
   단일 .html 은 index.html 로, .zip 은 풀어서 경로·확장자·상한을 검사한다.
   조용히 빼지 않는다: 형식이 틀리면 거부, 숨김 파일만 skipped 로 알린다.
   ===================================================================== */

export const SITE_LIMITS = {
  uploadBytes: 20 * 1024 * 1024,
  totalBytes: 50 * 1024 * 1024,
  files: 500,
  keepVersions: 10,
} as const;

export const SITE_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
};

export type BundleFile = { path: string; data: Buffer };
export type BundleResult =
  | { ok: true; files: BundleFile[]; skipped: { path: string; reason: string }[]; warnings: string[]; sizeBytes: number }
  | { ok: false; error: string };

const fail = (error: string): BundleResult => ({ ok: false, error });

export function normalizeBundlePath(raw: string): string | null {
  if (!raw || /[\x00-\x1f\\]/.test(raw)) return null;
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return null;
  const segs = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.length === 0 || segs.some((s) => s === "..")) return null;
  return segs.join("/");
}

export function extOf(p: string): string {
  const dot = p.lastIndexOf(".");
  return dot > p.lastIndexOf("/") ? p.slice(dot + 1).toLowerCase() : "";
}

export function mimeFor(p: string): string | null {
  return SITE_MIME[extOf(p)] ?? null;
}

function stripSingleRoot(files: BundleFile[]): BundleFile[] {
  if (files.length === 0 || files.some((f) => !f.path.includes("/"))) return files;
  const root = files[0].path.split("/")[0];
  if (files.some((f) => f.path.split("/")[0] !== root)) return files;
  return files.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }));
}

/** index.html 안의 루트 기준 경로(`/x`, `//x` 제외). /pub/<token>/ 밖을 가리켜 로드되지 않는다. */
function absoluteAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi)) refs.add(m[1]);
  return [...refs];
}

export function validateBundle({ filename, data }: { filename: string; data: Buffer }): BundleResult {
  if (data.length > SITE_LIMITS.uploadBytes) return fail("파일이 너무 큽니다(최대 20MB).");
  const lower = filename.toLowerCase();
  let files: BundleFile[];
  const skipped: { path: string; reason: string }[] = [];

  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    files = [{ path: "index.html", data }];
  } else if (lower.endsWith(".zip")) {
    let entries: { path: string; data: Buffer }[];
    try {
      entries = readZip(data, { maxEntries: SITE_LIMITS.files * 4, maxTotalBytes: SITE_LIMITS.totalBytes });
    } catch (e) {
      return fail(`zip 을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    files = [];
    for (const e of entries) {
      const p = normalizeBundlePath(e.path);
      if (!p) return fail(`허용되지 않는 경로가 있습니다: ${e.path}`);
      if (p.split("/").some((s) => s.startsWith(".") || s === "__MACOSX")) {
        skipped.push({ path: e.path, reason: "숨김·시스템 파일" });
        continue;
      }
      files.push({ path: p, data: e.data });
    }
    files = stripSingleRoot(files);
    // `__ts/` 는 /pub 가 쓰는 예약 폴더(내비 보고 스크립트) — 번들 파일이 가로채지 못하게 뺀다.
    files = files.filter((f) => {
      if (f.path.split("/")[0] !== RESERVED_SITE_DIR) return true;
      skipped.push({ path: f.path, reason: `예약 경로(${RESERVED_SITE_DIR}/)` });
      return false;
    });
  } else {
    return fail("HTML(.html) 또는 zip 파일만 올릴 수 있습니다.");
  }

  if (files.length === 0) return fail("zip 안에 파일이 없습니다.");
  if (files.length > SITE_LIMITS.files) return fail(`파일이 너무 많습니다(최대 ${SITE_LIMITS.files}개, 현재 ${files.length}개).`);

  // 대소문자를 무시하고 비교한다 — 저장소(macOS APFS 기본값)가 대소문자를 구분하지 않으면
  // `Assets/i.js` 와 `assets/i.js` 중 하나가 조용히 덮어써진다.
  const seen = new Set<string>();
  for (const f of files) {
    const key = f.path.toLowerCase();
    if (seen.has(key)) return fail(`같은 경로가 두 번 들어 있습니다(대소문자 무시): ${f.path}`);
    seen.add(key);
  }

  const bad = files.filter((f) => !mimeFor(f.path)).map((f) => f.path);
  if (bad.length) {
    return fail(`허용되지 않는 파일 형식: ${bad.slice(0, 10).join(", ")}${bad.length > 10 ? ` 외 ${bad.length - 10}개` : ""}`);
  }

  const index = files.find((f) => f.path === "index.html");
  if (!index) {
    const htmls = files.filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path).slice(0, 5);
    return fail(`zip 최상위에 index.html 이 필요합니다${htmls.length ? ` (발견한 html: ${htmls.join(", ")})` : ""}`);
  }

  const warnings: string[] = [];
  const abs = absoluteAssetRefs(index.data.toString("utf8"));
  if (abs.length) {
    warnings.push(
      `index.html 이 루트 기준 경로를 씁니다(${abs.slice(0, 5).join(", ")}) — 로드되지 않습니다. 상대경로로 빌드하세요(예: vite build --base=./).`,
    );
  }

  const ambiguous = ambiguousShellPaths(files.map((f) => f.path));
  if (ambiguous.length) {
    const list = ambiguous.slice(0, 10).map((a) => `/${a.pretty} → ${a.file} (${a.shadowed} 는 가려짐)`).join(", ");
    warnings.push(
      `같은 주소로 열리는 파일 쌍이 있습니다 — ${list}${ambiguous.length > 10 ? ` 외 ${ambiguous.length - 10}쌍` : ""}. ` +
        `셸 주소는 .html 을 먼저 열므로 폴더의 index.html 은 그 주소로 닿지 않습니다. 둘 중 하나의 이름을 바꾸세요.`,
    );
  }

  return { ok: true, files, skipped, warnings, sizeBytes: files.reduce((n, f) => n + f.data.length, 0) };
}

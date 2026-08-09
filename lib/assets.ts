/* =====================================================================
   첨부(이미지·파일) 링크 다루기 — 순수 함수. 내보내기·가져오기 양방향이 쓴다.

   격차조사 E4: 첨부가 `public/uploads/` 로컬 디스크에만 있고 백업·내보내기
   어디에도 실리지 않았다. DB 는 백업되는데 그 DB 가 가리키는 파일은 아니라,
   디스크를 잃으면 **행은 살아 있고 그림만 사라진 문서**가 남는다.

   여기서 정하는 것은 "본문 안의 목적지 문자열" 을 어떻게 읽고 바꾸느냐 하나다:
     - 내보내기: `/uploads/<ws>/<파일>` → `../../attachments/<파일>` (상대경로라
       옵시디언·VS Code 에서 그대로 열린다)
     - 가져오기: 상대경로 → zip 안의 실제 파일을 찾아 업로드로 복원 →
       `/uploads/<새 ws>/<새 파일명>`
   노션 export 처럼 md 옆에 이미지가 놓인 형태도 같은 규칙으로 걸린다 —
   "attachments/" 라는 이름을 특별대우하지 않고 **문서가 실제로 참조하는
   zip 안의 파일**을 첨부로 본다.

   코드블록 안은 건드리지 않는다. 문서에 코드 예제로 적어 둔 마크다운까지
   바꾸면 조용히 내용을 훼손하는 것이다.
   ===================================================================== */

export type AssetLink = {
  /** 목적지 문자열(꺾쇠·제목 제외) */
  href: string;
  /** markdown 안에서 href 가 시작하는 위치 */
  start: number;
  /** href 의 끝(배타적) */
  end: number;
};

/** ![alt](dest "title") / [text](dest) 의 목적지. 꺾쇠 형태 `(<a b.png>)` 도 받는다. */
const LINK_RE = /(!?)\[[^\]\n]*\]\(\s*(?:<([^>\n]*)>|([^()\s]+))(\s+"[^"\n]*"|\s+'[^'\n]*')?\s*\)/g;

/** 코드펜스(``` ~~~)와 인라인 코드(`…`)가 차지하는 구간. 이 안의 링크는 없는 셈 친다. */
function codeRanges(md: string): [number, number][] {
  const out: [number, number][] = [];
  const fence = /^[ \t]*(```|~~~).*$/gm;
  let open: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md))) {
    if (open === null) open = m.index;
    else {
      out.push([open, m.index + m[0].length]);
      open = null;
    }
  }
  if (open !== null) out.push([open, md.length]);

  const inline = /`+[^`\n]*`+/g;
  while ((m = inline.exec(md))) {
    const [s, e] = [m.index, m.index + m[0].length];
    if (!out.some(([a, b]) => s >= a && e <= b)) out.push([s, e]);
  }
  return out;
}

/** 본문에서 링크·이미지 목적지를 모두 뽑는다(코드 구간 제외). */
export function extractLinks(markdown: string): AssetLink[] {
  const skip = codeRanges(markdown);
  const inCode = (i: number) => skip.some(([a, b]) => i >= a && i < b);
  const out: AssetLink[] = [];
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(markdown))) {
    if (inCode(m.index)) continue;
    const angled = m[2] !== undefined;
    const href = angled ? m[2] : m[3];
    if (href === undefined) continue;
    // 목적지의 정확한 위치 — 치환할 때 나머지(제목·꺾쇠)를 건드리지 않기 위해
    const offset = m[0].indexOf(angled ? `<${href}>` : href);
    const start = m.index + offset + (angled ? 1 : 0);
    out.push({ href, start, end: start + href.length });
  }
  return out;
}

/** 우리가 가져올 수 없는 목적지(외부 URL·앵커)인가. */
export function isExternal(href: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("//") || href.startsWith("#") || href === "";
}

/** 퍼센트 인코딩을 풀고 쿼리·프래그먼트를 뗀다. 깨진 인코딩이면 원문을 준다. */
export function decodeHref(href: string): string {
  const bare = href.replace(/[?#].*$/, "");
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/**
 * 문서 위치를 기준으로 상대 목적지를 zip 안의 경로로 해석한다.
 * 절대 경로(`/…`)나 zip 루트를 벗어나는 경로는 null — 가져오기는 zip 밖을 읽지 않는다.
 */
export function resolveZipPath(docPath: string, href: string): string | null {
  if (href.startsWith("/") || isExternal(href)) return null;
  const segs = docPath.split("/").slice(0, -1);
  for (const seg of href.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length === 0) return null; // 루트 밖
      segs.pop();
    } else segs.push(seg);
  }
  return segs.length ? segs.join("/") : null;
}

/** 내보내기용: 문서에서 첨부로 가는 상대 목적지(세그먼트마다 퍼센트 인코딩). */
export function toRelativeHref(docPath: string, assetPath: string): string {
  const from = docPath.split("/").slice(0, -1);
  const to = assetPath.split("/");
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  const up = Array.from({ length: from.length - i }, () => "..");
  return [...up, ...to.slice(i).map(encodeURIComponent)].join("/");
}

/**
 * 목적지 문자열을 매핑대로 바꾼다. 매핑에 없는 목적지·코드 구간은 그대로.
 * 뒤에서부터 치환해 앞선 위치가 밀리지 않게 한다.
 */
export function rewriteHrefs(markdown: string, map: Record<string, string>): string {
  const links = extractLinks(markdown).filter((l) => map[l.href] !== undefined);
  let out = markdown;
  for (const l of links.reverse()) {
    out = out.slice(0, l.start) + map[l.href] + out.slice(l.end);
  }
  return out;
}

/**
 * 업로드 저장 파일명 — `<내용해시8>-<안전화한 원래 이름>`. `/api/upload` 와 같은 규칙이라
 * 같은 파일을 두 번 가져와도 파일이 늘지 않는다.
 *
 * 앞에 이미 붙어 있는 해시 접두는 **떼고** 다시 붙인다. 안 그러면 내보내기→가져오기를
 * 반복할 때마다 `h-h-h-이름.png` 로 접두가 한 겹씩 쌓인다(왕복 검증에서 실제로 나왔다).
 */
export function uploadFileName(original: string, contentHash: string): string {
  const base =
    original
      .split("/")
      .pop()!
      .replace(/[\x00-\x1f:*?"<>|]/g, "_")
      .replace(/^[0-9a-f]{8}-/, "")
      .trim()
      .slice(0, 120) || "file";
  return `${contentHash.slice(0, 8)}-${base}`;
}

/**
 * `/uploads/<workspaceId>/<파일명>` 목적지에서 파일명을 뽑는다.
 * 다른 워크스페이스·하위 폴더·경로 탈출은 null — 업로드 디렉터리는 평평하다.
 */
export function uploadsHrefFile(href: string, workspaceId: string): string | null {
  const decoded = decodeHref(href);
  const prefix = `/uploads/${workspaceId}/`;
  if (!decoded.startsWith(prefix)) return null;
  const name = decoded.slice(prefix.length);
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") return null;
  return name;
}

/* 셸 주소(/s/<slug>/<경로>) ↔ 사이트 파일 경로 사이의 순수 함수. 서버(셸 페이지)와
   클라이언트(주소창 동기화) 양쪽에서 쓰므로 node 모듈을 들이지 않는다.

   주소 → 파일 후보(앞에서부터 처음 있는 파일):
     ''          → index.html
     'a/b'       → a/b.html, a/b/index.html
     'a/b.html'  → a/b.html (이미 html 이면 그대로)
   파일 → 예쁜 주소(역방향):
     index.html → '' · a/index.html → 'a' · a/b.html → 'a/b' · 그 밖(.htm 등) → 그대로 */

/** /pub 가 붙이는 내비 보고 스크립트 등, 번들이 가질 수 없는 예약 최상위 폴더. */
export const RESERVED_SITE_DIR = "__ts";
export const NAV_SCRIPT_PATH = `${RESERVED_SITE_DIR}/nav.js`;
export const NAV_MESSAGE_TYPE = "ts-site-nav";

const MAX_PATH = 1024;
const MAX_HASH = 2048;

/** 이미 디코딩된 세그먼트를 검사한다. 이탈·숨김·예약 폴더·빈 세그먼트는 null. */
export function cleanSegments(segments: readonly string[]): string[] | null {
  if (segments.length === 0) return [];
  for (const s of segments) {
    if (!s || s === "." || s === ".." || s.startsWith(".")) return null;
    if (/[\x00-\x1f\\/]/.test(s) || s.includes(":")) return null;
  }
  if (segments[0] === RESERVED_SITE_DIR) return null;
  if (segments.join("/").length > MAX_PATH) return null;
  return [...segments];
}

export function shellFileCandidates(segments: readonly string[]): string[] | null {
  const clean = cleanSegments(segments);
  if (!clean) return null;
  if (clean.length === 0) return ["index.html"];
  const p = clean.join("/");
  if (/\.html?$/i.test(p)) return [p];
  return [`${p}.html`, `${p}/index.html`];
}

/** 같은 셸 주소로 열리는 `a.html` + `a/index.html` 쌍. shellFileCandidates 가 `.html` 을 먼저 보므로
    `/s/<slug>/a` 는 늘 `a.html` 을 열고 `a/index.html` 은 그 주소로 닿지 않는다(`a/index.html` 로 직접은 열림).
    번들 검사가 경고로 알린다 — 거부하진 않는다. */
export function ambiguousShellPaths(paths: readonly string[]): { pretty: string; file: string; shadowed: string }[] {
  const set = new Set(paths);
  const out: { pretty: string; file: string; shadowed: string }[] = [];
  for (const file of paths) {
    if (!file.endsWith(".html")) continue;
    const base = file.slice(0, -".html".length);
    const shadowed = `${base}/index.html`;
    if (base && set.has(shadowed)) out.push({ pretty: base, file, shadowed });
  }
  return out.sort((a, b) => a.pretty.localeCompare(b.pretty));
}

export function prettyPath(file: string): string {
  const p = file.replace(/^\/+/, "");
  if (p === "index.html") return "";
  if (p.endsWith("/index.html")) return p.slice(0, -"/index.html".length);
  if (p.endsWith(".html")) return p.slice(0, -".html".length);
  return p;
}

/** /s/<slug>/<pretty> — 세그먼트마다 인코딩한다. */
export function shellPath(slug: string, pretty: string): string {
  const rest = pretty ? `/${pretty.split("/").map(encodeURIComponent).join("/")}` : "";
  return `/s/${encodeURIComponent(slug)}${rest}`;
}

export type NavMessage = { path: string; hash: string };

/** iframe 이 보낸 메시지의 모양을 검사한다. 모양이 틀리면 null(무시). */
export function parseNavMessage(data: unknown): NavMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== NAV_MESSAGE_TYPE || typeof d.path !== "string") return null;
  const hash = typeof d.hash === "string" ? d.hash : "";
  if (hash && (!hash.startsWith("#") || hash.length > MAX_HASH || /[\x00-\x1f]/.test(hash))) return null;
  const segs = d.path === "" ? [] : d.path.split("/");
  if (!cleanSegments(segs)) return null;
  return { path: d.path, hash };
}

/** 메시지 → 셸 주소창에 둘 같은 사이트 경로(항상 /s/ 로 시작). 모양이 틀리면 null. */
export function navTarget(slug: string, data: unknown): string | null {
  const m = parseNavMessage(data);
  if (!m) return null;
  return shellPath(slug, prettyPath(m.path)) + m.hash;
}

/** 셸이 받은 message 이벤트 → replaceState 할 경로. 우리 iframe 이 보낸 것만 받는다:
    source 가 그 iframe 의 window 이고, 샌드박스(allow-same-origin 없음)라 origin 이 "null" 이어야 한다. */
export function navTargetForEvent(
  ev: { source: unknown; origin: string; data: unknown },
  frameWindow: unknown,
  slug: string,
): string | null {
  if (!frameWindow || ev.source !== frameWindow || ev.origin !== "null") return null;
  return navTarget(slug, ev.data);
}

/** /pub 가 HTML 응답 끝에 붙이는 스크립트 본문. 페이지 경로(토큰 뒤)와 해시를 부모 셸에 알린다.
    셸은 event.source 가 자기 iframe 인지 확인한 뒤 replaceState 만 한다. */
export const NAV_SCRIPT = `(function(){try{if(window.parent===window)return;function send(){try{var m=location.pathname.match(/^\\/pub\\/[^/]+\\/(.*)$/);if(!m)return;var p=m[1].split("/").map(function(s){try{return decodeURIComponent(s)}catch(e){return s}}).join("/");window.parent.postMessage({type:"${NAV_MESSAGE_TYPE}",path:p,hash:location.hash},"*")}catch(e){}}send();window.addEventListener("hashchange",send);window.addEventListener("popstate",send)}catch(e){}})();\n`;

/** HTML 에 내비 스크립트 태그를 꽂는다 — 마지막 </body> 앞, 없으면 </html> 앞, 둘 다 없으면 끝. */
export function injectNavScript(html: string, src: string): string {
  const tag = `<script src="${src.replace(/[&"<>]/g, "")}"></script>`;
  const lower = html.toLowerCase();
  const at = lower.lastIndexOf("</body>") >= 0 ? lower.lastIndexOf("</body>") : lower.lastIndexOf("</html>");
  return at >= 0 ? html.slice(0, at) + tag + html.slice(at) : html + tag;
}

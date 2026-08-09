/* =====================================================================
   콜백 URL 검증 (SSRF 축소) — 순수 함수. 네트워크도 DNS 도 안 본다.

   `/api/llm/classify` 는 호출자가 준 `callbackUrl` 로 **서버가** 결과를 POST 한다.
   즉 "이 서버로 하여금 임의 주소에 요청을 보내게 하는" 기능이고, 검사가
   `^https?://` 하나뿐이었다. editor 면 누구나 `http://127.0.0.1:3002/api/...`
   이나 `http://169.254.169.254/latest/meta-data/` 를 적을 수 있었다 — 방화벽
   안쪽에서 나가는 요청이라 외부에서 못 하는 일을 대신 시킬 수 있다.

   여기서 하는 일은 **대상이 내부인지** 를 보는 것이다:
     · 스킴은 http/https 만. file·gopher·dict 같은 것들은 SSRF 의 고전 확장이다.
     · URL 에 자격증명(`user:pw@`)이 박혀 있으면 거절 — 파서 차이로 호스트가
       달라 보이게 만드는 흔한 우회다.
     · 루프백·사설망·링크로컬·CGNAT(=tailscale)·IPv6 사설, 그리고 8진수·16진수·
       정수로 위장한 IP 표기.
     · `.local`·`.internal`·`localhost` 계열 이름.
     · 선택적으로 호스트 allowlist(운영자가 좁히고 싶을 때).

   **하지 않는 것: DNS 해석.** 공격자가 자기 도메인을 10.0.0.1 로 가리키면
   이름만 보는 검사는 못 막는다(DNS rebinding). 그걸 막으려면 해석한 IP 로
   연결까지 고정해야 하는데(fetch 로는 불가), 그건 별도 슬라이스다. 그래서 이
   모듈의 약속은 "직접 지목한 내부 주소를 막는다" 까지다 — allowlist 를 설정하면
   그 범위를 벗어난 이름 자체가 막히므로 rebinding 도 같이 닫힌다.
   ===================================================================== */

export type CallbackCheck = { ok: true } | { ok: false; reason: string };

export type CallbackCheckOptions = {
  /** 비어 있으면 "내부 차단만". 값이 있으면 그 호스트(와 하위 도메인)만 허용한다. */
  allowHosts?: string[];
  /** 사설·루프백 허용(로컬 개발에서 자기 서버로 콜백받을 때만). */
  allowPrivate?: boolean;
};

const INTERNAL_SUFFIXES = [".local", ".internal", ".localhost", ".home.arpa", ".lan"];
const INTERNAL_NAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

/** 설정 문자열(콤마 구분) → 호스트 목록. URL 을 적어도 호스트만 뽑는다. */
export function parseHostAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    let host = s;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
      try {
        host = new URL(s).hostname;
      } catch {
        continue;
      }
    }
    host = normalizeHost(host);
    if (host && !out.includes(host)) out.push(host);
  }
  return out;
}

/** 소문자화 + 후행 점 제거 + 대괄호(IPv6) 제거. */
function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
}

/**
 * 점 4개 IPv4 뿐 아니라 **8진수·16진수·정수 표기**까지 32비트 값으로 되돌린다.
 * `http://2130706433/` 은 브라우저·libc 가 127.0.0.1 로 읽는다 — 문자열만 보면
 * 통과하는 대표적 우회라서 여기서 숫자로 환원해 검사한다.
 */
function toIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // 표기가 짧으면 마지막 조각이 남은 바이트를 전부 먹는다(inet_aton 규칙).
  const last = nums[nums.length - 1];
  const head = nums.slice(0, -1);
  if (head.some((n) => n > 255)) return null;
  const maxLast = 2 ** (8 * (4 - head.length));
  if (last >= maxLast) return null;
  let value = 0;
  for (const n of head) value = (value << 8) | n;
  return value * maxLast + last;
}

function isPrivateIpv4(v: number): boolean {
  const a = (v >>> 24) & 255;
  const b = (v >>> 16) & 255;
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 사설
    a === 127 || // 루프백
    (a === 169 && b === 254) || // 링크로컬 + 클라우드 메타데이터
    (a === 172 && b >= 16 && b <= 31) || // 사설
    (a === 192 && b === 168) || // 사설
    (a === 100 && b >= 64 && b <= 127) || // CGNAT — tailscale 이 이 대역을 쓴다
    (a === 192 && b === 0) || // 192.0.0.0/24 (IETF), 192.0.2.0/24 (문서용)
    a === 224 || // 멀티캐스트
    a >= 240 // 예약
  );
}

/**
 * IPv6 을 8개 hextet 으로 펼친다(`::` 압축·꼬리의 v4 표기 포함). 못 읽으면 null.
 *
 * 펼쳐야 하는 이유: URL 파서가 `[::ffff:10.0.0.1]` 을 `[::ffff:a00:1]` 로 정규화한다.
 * 문자열 패턴만 보면 매핑된 사설주소를 놓친다.
 */
function expandIpv6(host: string): number[] | null {
  let h = host.toLowerCase();
  if (!h.includes(":")) return null;
  let tail: number[] = [];
  // 꼬리가 점표기 v4 면 두 hextet 으로 바꿔 붙인다
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (dotted) {
    const v = toIpv4(dotted[1]);
    if (v == null) return null;
    tail = [(v >>> 16) & 0xffff, v & 0xffff];
    h = h.slice(0, dotted.index);
    if (h.endsWith(":") && !h.endsWith("::")) h = h.slice(0, -1);
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const hex = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const x of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(x)) return null;
      out.push(parseInt(x, 16));
    }
    return out;
  };
  const left = hex(halves[0].replace(/:$/, ""));
  const right = halves.length === 2 ? hex(halves[1].replace(/^:/, "")) : [];
  if (!left || !right) return null;
  const known = [...left, ...right, ...tail];
  if (halves.length === 1) return known.length === 8 ? known : null;
  if (known.length > 8) return null;
  return [...left, ...Array(8 - known.length).fill(0), ...right, ...tail];
}

function isPrivateIpv6(host: string): boolean {
  const h = expandIpv6(host);
  if (!h) return false;
  if (h.every((x) => x === 0)) return true; // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 루프백
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 유니크 로컬
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 링크로컬
  // ::ffff:a.b.c.d — v4 를 감싼 형태. 감싸도 v4 규칙이 그대로 적용된다.
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return isPrivateIpv4(((h[6] << 16) | h[7]) >>> 0);
  }
  return false;
}

/** host 가 allow 목록에 있거나 그 하위 도메인인가. */
function hostAllowed(host: string, allow: string[]): boolean {
  return allow.some((a) => host === a || host.endsWith(`.${a}`));
}

/** 콜백 URL 이 나가도 되는 대상인지. 거절 이유는 사람이 읽을 문장으로 준다. */
export function checkCallbackUrl(raw: string, opts: CallbackCheckOptions = {}): CallbackCheck {
  if (!raw || typeof raw !== "string") return { ok: false, reason: "callbackUrl 이 비어 있습니다." };
  if (/[\x00-\x1f\x7f]/.test(raw)) return { ok: false, reason: "callbackUrl 에 제어문자가 있습니다." };

  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "callbackUrl 이 올바른 URL 이 아닙니다." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "callbackUrl 은 http(s) 만 됩니다." };
  }
  if (u.username || u.password) {
    return { ok: false, reason: "callbackUrl 에 자격증명(user:pass@)을 넣을 수 없습니다." };
  }

  const host = normalizeHost(u.hostname);
  if (!host) return { ok: false, reason: "callbackUrl 에 호스트가 없습니다." };

  if (!opts.allowPrivate) {
    if (INTERNAL_NAMES.has(host) || INTERNAL_SUFFIXES.some((s) => host.endsWith(s))) {
      return { ok: false, reason: `내부 호스트로는 콜백할 수 없습니다: ${host}` };
    }
    const v4 = toIpv4(host);
    if (v4 != null && isPrivateIpv4(v4)) {
      return { ok: false, reason: `사설·루프백 주소로는 콜백할 수 없습니다: ${host}` };
    }
    if (host.includes(":") && isPrivateIpv6(host)) {
      return { ok: false, reason: `사설·루프백 주소로는 콜백할 수 없습니다: ${host}` };
    }
  }

  const allow = opts.allowHosts ?? [];
  if (allow.length > 0 && !hostAllowed(host, allow)) {
    return { ok: false, reason: `허용 목록에 없는 콜백 호스트입니다: ${host}` };
  }
  return { ok: true };
}

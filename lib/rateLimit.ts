/* 인메모리 토큰버킷 레이트 리미터 + 요청 → 클라이언트 키 도출(순수).
 *
 * ⚠️ 단일 프로세스(launchd 1 인스턴스) 전제; 다중 인스턴스면 공유 저장소 필요.
 *    상태는 모듈 스코프 Map 에 있고 프로세스(엣지 샌드박스 컨텍스트) 수명 동안만 유지된다.
 *    재시작하면 초기화되고, 인스턴스가 N 개면 실효 한도가 N 배가 된다.
 *
 * 엣지 미들웨어(middleware.ts — Next 16 에서 `middleware` 파일은 기본 edge 런타임)에서 import 된다:
 * Node 전용 import(node:crypto 등) 금지. 토큰 해시는 동기 FNV-1a 로 한다(보안 해시가 아니라
 * 버킷 키를 만들 뿐 — 원문 토큰을 메모리 키에 남기지 않는 용도). */

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterSec: number };

import { isAgentTokenFormat } from "./agentTokenFormat";

export type RateLimiter = {
  check(key: string, now?: number): RateLimitResult;
  size(): number;
};

type Bucket = { tokens: number; updatedAt: number };

/** 키 클래스: 토큰 유래(`t:`) / IP 유래(`ip:`·`pair:`).
 *  `u:`·`site:` 는 일부러 클래스 상한이 없다 — `u:` 는 로그인한 멤버 수로, `site:` 는 서명된 /pub 프록시
 *  (사이트 × 초대된 뷰어)로 키 수가 자연히 묶인다. 공격자가 마음대로 늘릴 수 있는 키(위조 토큰·IP 회전)만 막는다.
 *  (누락이 아니다 — 전체 LRU 10k 가 최후 방어선.) */
export type KeyClass = "token" | "ip";

export function keyClassOf(key: string): KeyClass | null {
  if (key.startsWith("t:")) return "token";
  if (key.startsWith("ip:") || key.startsWith("pair:")) return "ip";
  return null;
}

export const OVERFLOW_KEYS: Record<KeyClass, string> = { token: "overflow:token", ip: "overflow:ip" };
/** 클래스별 서로 다른 키 상한(LRU 10k 안에서). 가득 차면 새 키는 클래스 공용 overflow 버킷을 나눠 쓴다. */
export const DEFAULT_CLASS_MAX: Record<KeyClass, number> = { token: 2_000, ip: 8_000 };

/** limit 개를 windowMs 동안 균등 회복하는 토큰버킷(버스트 상한 = limit).
 *  거절된 요청은 토큰을 깎지 않는다. 키가 max 를 넘으면 가장 오래 안 쓴 키부터 버린다(LRU).
 *  클래스별 상한(classMax)에 닿으면 그 클래스의 새 키는 overflow 버킷 하나를 공유한다 —
 *  키 폭주(위조 토큰·IP 회전)가 다른 클래스의 정상 키를 LRU 로 밀어내지 못하고, 폭주한 쪽만 서로 깎인다. */
export function createRateLimiter(opts: {
  limit: number;
  windowMs: number;
  max?: number;
  classMax?: Partial<Record<KeyClass, number>>;
}): RateLimiter {
  const { limit, windowMs } = opts;
  const max = opts.max ?? 10_000;
  const classMax = { ...DEFAULT_CLASS_MAX, ...opts.classMax };
  const classCount: Record<KeyClass, number> = { token: 0, ip: 0 };
  const overflowKeys = new Set<string>(Object.values(OVERFLOW_KEYS));
  const ratePerMs = limit / windowMs;
  const buckets = new Map<string, Bucket>();

  function reclaimOldestRefilled(cls: KeyClass, now: number): boolean {
    for (const [k, v] of buckets) {
      if (overflowKeys.has(k) || keyClassOf(k) !== cls) continue;
      if (now - v.updatedAt < windowMs) return false; // 가장 오래된 것도 활성 → 전부 활성
      buckets.delete(k);
      classCount[cls]--;
      return true;
    }
    return false;
  }

  return {
    check(rawKey: string, now: number = Date.now()): RateLimitResult {
      let key = rawKey;
      const cls = keyClassOf(key);
      if (cls && !buckets.has(key) && classCount[cls] >= classMax[cls]) {
        // 클래스가 가득 — 먼저 다 리필된(= 쓴 예산이 없는) 가장 오래된 같은 클래스 버킷의 슬롯을 회수한다.
        // Map 은 삽입(=마지막 사용) 순서라 같은 클래스의 첫 항목만 보면 된다: 그게 아직 활성이면 뒤는 더 최근이다.
        if (!reclaimOldestRefilled(cls, now)) key = OVERFLOW_KEYS[cls];
      }
      let b = buckets.get(key);
      if (b) {
        buckets.delete(key); // 재삽입으로 LRU 순서 갱신
        const elapsed = Math.max(0, now - b.updatedAt);
        b = { tokens: Math.min(limit, b.tokens + elapsed * ratePerMs), updatedAt: now };
      } else {
        while (buckets.size >= max) {
          const oldest = buckets.keys().next().value;
          if (oldest === undefined) break;
          buckets.delete(oldest);
          const oc = overflowKeys.has(oldest) ? null : keyClassOf(oldest);
          if (oc) classCount[oc]--;
        }
        const kc = overflowKeys.has(key) ? null : keyClassOf(key);
        if (kc) classCount[kc]++;
        b = { tokens: limit, updatedAt: now };
      }
      buckets.set(key, b);

      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
      }
      const waitMs = (1 - b.tokens) / ratePerMs;
      return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
    },
    size: () => buckets.size,
  };
}

function fnv1a32(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function tokenDigest(token: string): string {
  return (fnv1a32(token, 0x811c9dc5) + fnv1a32(token, 0x9747b28c)).slice(0, 12);
}

/** 요청의 IP. x-forwarded-for **가장 오른쪽** 값 → x-real-ip → fallbackIp → null.
 *
 *  가장 오른쪽 값은 가장 가까운 프록시(tailscale serve)가 붙인 홉이다. 왼쪽 값들은 클라이언트가
 *  보낸 그대로라 위조할 수 있으므로 쓰지 않는다(첫 값을 쓰면 XFF 를 바꿔 가며 버킷을 새로 받는다).
 *  프록시 없이 직접 들어온 요청은 Next 가 소켓 주소로 채운다(`??=` — 이미 있으면 그대로 둔다).
 *
 *  ⚠️ 남은 구멍: LAN·tailnet 에서 :3002 로 **직접** 붙으면 프록시를 거치지 않으므로 XFF 전체를
 *  클라이언트가 정한다(가장 오른쪽 값도 위조 가능). 코드로는 못 막는다 — 운영 완화책은
 *  `next start -H 127.0.0.1` 로 루프백에만 바인딩해 tailscale serve 만 앱에 닿게 하는 것이다. */
export function clientIp(headers: Headers, fallbackIp?: string): string | null {
  const hops = headers.get("x-forwarded-for")?.split(",").map((s) => s.trim()).filter(Boolean);
  const xff = hops?.[hops.length - 1];
  if (xff) return xff;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  return fallbackIp || null;
}

export function ipKey(headers: Headers, fallbackIp?: string): string {
  return `ip:${clientIp(headers, fallbackIp) ?? "unknown"}`;
}

// lib/sites/proxyIdentity.ts 의 PROXY_SIG_HEADER·PROXY_SITE_HEADER·PROXY_VIEWER_HEADER 와 같은 값.
// 그 모듈은 node:crypto 를 import 하므로 엣지에서 못 끌어온다 — 일치는 rateLimit.test.ts 가 검사한다.
export const SITE_SIG_HEADER = "x-teamspace-proxy-sig";
export const SITE_ID_HEADER = "x-teamspace-site-id";
export const SITE_VIEWER_HEADER = "x-teamspace-viewer";

/** /pub 프록시를 타고 온 site-intake 요청의 키. 프록시 서명 헤더가 있으면 `site:<사이트 id>:<뷰어>`,
 *  없으면 IP. 프록시는 루프백에서 XFF 없이 부르므로 IP 로 세면 모든 게스트가 한 버킷(127.0.0.1)을 쓴다.
 *  서명은 여기서 검증하지 않는다(엣지 — 키 없음): 헤더를 위조해도 버킷만 흩어질 뿐이고,
 *  라우트가 서명 확인에서 싸게 거절한다. 검증 후 (사이트, 뷰어)당 한도는 라우트(lib/sites/intake.ts)에 따로 있다. */
export function siteViewerKey(headers: Headers, fallbackIp?: string): string {
  const sig = headers.get(SITE_SIG_HEADER)?.trim();
  const site = headers.get(SITE_ID_HEADER)?.trim();
  const viewer = headers.get(SITE_VIEWER_HEADER)?.trim().toLowerCase();
  if (sig && site && viewer) return `site:${site}:${viewer}`;
  return ipKey(headers, fallbackIp);
}

/** 세션 사용자 id/email → `u:<…>` / x-ws-token → `t:<해시 12자>` / IP → `ip:<…>` / `ip:unknown`. */
export function clientKey(
  req: { headers: Headers; auth?: { user?: { id?: string | null; email?: string | null } | null } | null },
  fallbackIp?: string,
): string {
  const user = req.auth?.user;
  const uid = user?.id || user?.email;
  if (uid) return `u:${uid}`;
  const token = req.headers.get("x-ws-token");
  // 형식(wst_<64 hex>)이 맞는 토큰만 키로 쓴다 — 위조 토큰을 돌려 가며 새 버킷을 받는 우회를 막는다.
  // (형식이 맞아도 존재 검증은 못 한다 — 그건 requireCtx. 그래서 클래스 상한이 따로 있다.)
  if (token && isAgentTokenFormat(token)) return `t:${tokenDigest(token)}`;
  return ipKey(req.headers, fallbackIp);
}

/** 페어링 코드 형식 — lib/pairing.ts 의 PAIRING_CODE_RE 와 같다(그 모듈은 node:crypto 를 import 해 엣지에서
 *  못 끌어온다 — 일치는 rateLimit.test.ts 가 검사). */
export const PAIR_CODE_RE = /^[0-9a-f]{32}$/;

/** 페어링 폴링 키 — `pair:<ip>:<코드>`. 설치기마다 코드가 달라 같은 IP 의 설치기 둘이 한 버킷을 나눠 쓰지 않는다.
 *  코드가 형식에 맞을 때만 코드별 키를 쓴다 — 아무 문자열이나 키로 쓰면 한 IP 가 코드를 돌려 가며
 *  `pair:` 슬롯(ip 클래스)을 다 써 버린다. 형식 불량·`approve` 같은 비폴링 하위 경로·코드 없음은 IP 키. */
export function pairKey(pathname: string, headers: Headers, fallbackIp?: string): string {
  const code = pathname.split("/")[3];
  if (!code || !PAIR_CODE_RE.test(code)) return ipKey(headers, fallbackIp);
  return `pair:${clientIp(headers, fallbackIp) ?? "unknown"}:${code}`;
}

/** 정책 + 요청 → 버킷 키. `off`(RATE_LIMIT=off 킬스위치)면 null = 세지 않음.
 *  ip 정책은 세션·토큰을 무시한다. */
export function keyFor(
  policy: { key: "ip" | "client" | "viewer" | "pair" },
  req: { headers: Headers; pathname?: string; auth?: Parameters<typeof clientKey>[0]["auth"] },
  opts: { off?: boolean; fallbackIp?: string } = {},
): string | null {
  if (opts.off) return null;
  const { headers } = req;
  switch (policy.key) {
    case "ip":
      return ipKey(headers, opts.fallbackIp);
    case "viewer":
      return siteViewerKey(headers, opts.fallbackIp);
    case "pair":
      return pairKey(req.pathname ?? "", headers, opts.fallbackIp);
    default:
      return clientKey(req, opts.fallbackIp);
  }
}

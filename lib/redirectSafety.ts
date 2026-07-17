// 오픈 리다이렉트 방지 — 로그인 콜백 URL(callbackUrl)이 동일 출처의 내부 경로인지 검증한다.
// 블록리스트("//" 로 시작하지 않으면 허용) 방식은 "/\evil.com" 같은 백슬래시 변형을 놓친다.
// 일부 브라우저/파서가 경로 선두의 "\" 를 "/" 로 취급해 사실상 프로토콜 상대 URL(//evil.com)로
// 해석할 수 있으므로, 화이트리스트 방식(내부 상대경로만 허용)으로 전환한다.
export function safeCallbackPath(raw: string | null | undefined): string {
  const FALLBACK = "/";

  if (!raw) return FALLBACK;

  // 제어문자(개행 등) 포함 시 헤더/파서 혼동을 유발할 수 있어 즉시 거부.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return FALLBACK;

  // 백슬래시는 일부 파서가 "/" 로 정규화해 "//evil.com" 형태로 둔갑할 수 있으므로 전면 금지.
  if (raw.includes("\\")) return FALLBACK;

  // 내부 상대경로는 반드시 단일 "/" 로 시작하고, "//"(프로토콜 상대 URL)로 시작하지 않는다.
  if (!raw.startsWith("/") || raw.startsWith("//")) return FALLBACK;

  // 방어적 이중 검증: 임의 base 로 파싱했을 때도 동일 출처·루트 경로여야 한다.
  // (스킴 프리픽스가 섞였거나 파서가 예상 밖으로 해석하는 입력을 추가로 걸러낸다.)
  try {
    const parsed = new URL(raw, "http://x.local");
    if (parsed.origin !== "http://x.local") return FALLBACK;
    if (!parsed.pathname.startsWith("/")) return FALLBACK;
  } catch {
    return FALLBACK;
  }

  return raw;
}

/**
 * @멘션 파서 (W6, 순수 로직).
 * 마크다운/플레인 본문에서 `@` 뒤 텍스트를 멤버 이름 목록과 대조한다.
 * 이름에 공백·괄호가 올 수 있어 정규식 단어 경계 대신 "이름 프리픽스 매칭"을 쓴다:
 * 각 `@` 위치에서 이어지는 문자열이 어떤 멤버 이름으로 시작하면 그 이름(가장 긴 것)을 채택.
 */
export function parseMentions(body: string, memberNames: string[]): string[] {
  if (!body || memberNames.length === 0) return [];
  // 긴 이름 우선 매칭 (예: "테스트 (Claude QA)" 가 "테스트" 보다 먼저)
  const names = [...memberNames].sort((a, b) => b.length - a.length);
  const found: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "@") continue;
    // 이메일(user@host) 오검출 방지: @ 바로 앞이 영숫자면 스킵
    if (i > 0 && /[A-Za-z0-9._-]/.test(body[i - 1])) continue;
    const after = body.slice(i + 1);
    const hit = names.find((n) => after.startsWith(n));
    if (hit && !found.includes(hit)) found.push(hit);
  }
  return found;
}

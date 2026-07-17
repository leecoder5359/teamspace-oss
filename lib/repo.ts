/* repo URL 유틸. 순수 함수(테스트: lib/repo.test.ts). */

/** repo URL을 "owner/repo" 라벨로. 인식 못 하면 트림한 입력 그대로. */
export function repoLabel(url: string): string {
  const s = (url ?? "").trim();
  if (!s) return "";
  // git@github.com:owner/repo(.git) 형식
  const ssh = s.match(/^git@[^:]+:(.+?)(?:\.git)?\/?$/);
  if (ssh) return ssh[1];
  // https://host/owner/repo(.git)(/)
  const https = s.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/);
  if (https) return https[1];
  return s;
}

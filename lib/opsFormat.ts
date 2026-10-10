/** 운영 상태 화면·CLI 공용 표시 포맷 — 의존성 없는 순수 함수(scripts/ws.ts 가 상대경로로 import). */
export function formatTokens(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("ko-KR");
}

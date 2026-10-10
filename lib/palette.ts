/* =====================================================================
   커맨드 팔레트 매칭·랭킹. 순수 함수(React·DOM 없음).

   격차조사 F3·F4: 전역 단축키 핸들러가 **한 곳도 없었다**(metaKey/ctrlKey 전수 0).
   옵시디언 Ctrl+P·노션 Cmd+K 는 부가 기능이 아니라 주 이동 수단인데, 문서가
   400개를 넘은 워크스페이스에서 사이드바 클릭만으로는 감당이 안 된다.

   매칭은 두 단계다:
     1) 부분문자열(연속) — 사람이 기대하는 1순위
     2) 순서만 맞는 흩어진 글자(subsequence) — "dbv" → "DatabaseView"
   둘 다 못 맞추면 후보에서 뺀다. 순서를 무시하는 매칭은 넣지 않았다 —
   결과가 왜 떴는지 설명이 안 되면 팔레트는 신뢰를 잃는다.
   ===================================================================== */

export type PaletteKind = "command" | "doc" | "board" | "task" | "project";

export type PaletteItem = {
  id: string;
  kind: PaletteKind;
  title: string;
  /** 화면 오른쪽에 흐리게 붙는 보조 설명(프로젝트명·경로 등) */
  hint?: string;
  /** 선택 시 이동할 경로. 없으면 run 이 있어야 한다. */
  href?: string;
  /** 종류별 기본 가중치를 덮어쓸 때 */
  weight?: number;
};

/** 종류별 기본 가중치 — 같은 점수면 명령이 먼저, 그다음 문서. */
const KIND_WEIGHT: Record<PaletteKind, number> = {
  command: 30,
  doc: 20,
  board: 18,
  project: 15,
  task: 10,
};

export type Scored = { item: PaletteItem; score: number; matched: number[] };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * 연속 부분문자열 매칭. 찾으면 [시작..끝) 인덱스 목록을 준다.
 * 앞쪽에서 맞을수록·단어 경계에서 시작할수록 점수가 높다.
 */
function substringMatch(hay: string, needle: string): { score: number; matched: number[] } | null {
  const i = hay.indexOf(needle);
  if (i < 0) return null;
  const atStart = i === 0;
  const atWord = i > 0 && /[\s\-_/·]/.test(hay[i - 1]);
  // 기본 1000점에서 시작 위치만큼 감점 — 앞에서 맞은 게 더 좋다
  let score = 1000 - Math.min(i, 200);
  if (atStart) score += 300;
  else if (atWord) score += 150;
  // 짧은 대상에서 맞을수록 정확한 매칭에 가깝다
  score += Math.max(0, 60 - hay.length);
  return { score, matched: Array.from({ length: needle.length }, (_, k) => i + k) };
}

/** 순서만 맞으면 되는 흩어진 매칭. 붙어 있을수록 점수가 높다. */
function subsequenceMatch(hay: string, needle: string): { score: number; matched: number[] } | null {
  const matched: number[] = [];
  let hi = 0;
  let streak = 0;
  let score = 300;
  for (const ch of needle) {
    const found = hay.indexOf(ch, hi);
    if (found < 0) return null;
    if (found === hi && matched.length) {
      streak++;
      score += 12 + streak * 3; // 연속으로 이어질수록 가산
    } else {
      streak = 0;
      score -= Math.min(found - hi, 20); // 건너뛴 만큼 감점
    }
    matched.push(found);
    hi = found + 1;
  }
  return { score, matched };
}

/** 항목 하나를 질의에 대해 채점. 매칭 실패면 null. */
export function scoreItem(item: PaletteItem, query: string): Scored | null {
  const q = norm(query);
  if (!q) return { item, score: item.weight ?? KIND_WEIGHT[item.kind], matched: [] };

  const title = norm(item.title);
  const hit = substringMatch(title, q) ?? subsequenceMatch(title, q);
  if (hit) {
    return { item, score: hit.score + (item.weight ?? KIND_WEIGHT[item.kind]), matched: hit.matched };
  }

  // 제목이 안 맞으면 보조설명에서 찾되, 눈에 덜 띄므로 크게 감점한다
  if (item.hint) {
    const h = substringMatch(norm(item.hint), q);
    if (h) return { item, score: h.score / 3 + (item.weight ?? KIND_WEIGHT[item.kind]), matched: [] };
  }
  return null;
}

/**
 * 후보 전체를 채점해 정렬한다.
 * 동점이면 제목이 짧은 것 → 사전순으로 갈라 **매번 같은 순서**가 나오게 한다
 * (순서가 흔들리면 근육 기억이 안 생기고, 그게 팔레트를 못 쓰게 만든다).
 */
export function rankItems(items: readonly PaletteItem[], query: string, limit = 30): Scored[] {
  const out: Scored[] = [];
  for (const it of items) {
    const s = scoreItem(it, query);
    if (s) out.push(s);
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.item.title.length - b.item.title.length ||
      a.item.title.localeCompare(b.item.title) ||
      a.item.id.localeCompare(b.item.id),
  );
  return out.slice(0, limit);
}

/** 목록 안에서 커서를 옮긴다. 끝에서 반대편으로 감긴다(빈 목록이면 0). */
export function moveCursor(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((current + delta) % length) + length) % length;
}

/** 이동만 하는 정적 명령들 — 사이드바에 있는 화면을 키보드로 열기 위한 것. */
export const NAV_COMMANDS: PaletteItem[] = [
  { id: "nav:search", kind: "command", title: "검색", href: "/search" },
  { id: "nav:dashboard", kind: "command", title: "대시보드", href: "/dashboard" },
  { id: "nav:docs", kind: "command", title: "문서", href: "/docs" },
  { id: "nav:inbox", kind: "command", title: "알림", href: "/inbox" },
  { id: "nav:projects", kind: "command", title: "프로젝트", href: "/projects" },
  { id: "nav:calendar", kind: "command", title: "캘린더", href: "/calendar" },
  { id: "nav:reminders", kind: "command", title: "리마인더", href: "/reminders" },
  { id: "nav:approvals", kind: "command", title: "승인", href: "/approvals" },
  { id: "nav:slack", kind: "command", title: "슬랙", href: "/slack" },
  { id: "nav:aiconnect", kind: "command", title: "AI 연결", href: "/aiconnect" },
  { id: "nav:members", kind: "command", title: "멤버", href: "/members" },
  { id: "nav:settings", kind: "command", title: "설정", href: "/settings" },
  { id: "nav:clip", kind: "command", title: "웹 클리퍼", href: "/clip" },
];

// 대시보드 "에이전트 세션" 카드용 순수 요약. GET /api/sessions 응답 모양을 그대로 받는다.
export type SessionLike = {
  id: string;
  externalId: string;
  project: string | null;
  cwd: string | null;
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
  // GET /api/sessions 가 내려준다(main 3d7605d). 있으면 활동 시각으로 우선 사용한다.
  lastSeenAt?: string | null;
  _count: { items: number };
};

export type SessionTop = { id: string; title: string; status: "active" | "ended"; itemCount: number; updatedAt: string };
export type SessionSummary = { active: number; recent: number; lastActivityAt: string | null; top: SessionTop[] };

const ACTIVE_MS = 10 * 60_000;
const RECENT_MS = 24 * 60 * 60_000;

function titleOf(s: SessionLike): string {
  if (s.project) return s.project;
  const last = s.cwd?.split("/").filter(Boolean).pop();
  return last || s.externalId;
}

export function summarizeSessions(sessions: SessionLike[], now: Date): SessionSummary {
  const rows = sessions
    .map((s) => {
      const updatedAt = s.lastSeenAt ?? s.endedAt ?? s.startedAt;
      return { s, updatedAt, t: Date.parse(updatedAt) };
    })
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => b.t - a.t);

  const n = now.getTime();
  const active = rows.filter((r) => r.s.status === "active" && n - r.t <= ACTIVE_MS).length;
  const recent = rows.filter((r) => n - r.t <= RECENT_MS).length;
  return {
    active,
    recent,
    lastActivityAt: rows[0]?.updatedAt ?? null,
    top: rows.slice(0, 3).map(({ s, updatedAt }) => ({
      id: s.id,
      title: titleOf(s),
      status: s.status,
      itemCount: s._count.items,
      updatedAt,
    })),
  };
}

export function relativeTime(iso: string, now: Date): string {
  const min = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 60 / 24)}일 전`;
}

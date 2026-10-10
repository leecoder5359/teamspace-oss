/** 알림 묶어 보기 (F1): 같은 종류·같은 링크의 알림을 24시간 창으로 묶는다. 순수 함수. */

export type NotifLike = {
  id: string;
  type: string;
  title: string;
  link: string | null;
  readAt: Date | string | null;
  createdAt: Date | string;
};

export type NotifGroup = {
  key: string;
  type: string;
  link: string | null;
  count: number;
  unread: number;
  latestAt: string;
  ids: string[];
  /** 최신순 제목 최대 3개 */
  sample: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const ts = (d: Date | string) => new Date(d).getTime();

export function groupNotifications(list: readonly NotifLike[], now: Date = new Date()): NotifGroup[] {
  // 시계 어긋남으로 미래 시각이 찍힌 알림은 now 로 눌러 24h 창 계산을 안정시킨다
  const cap = now.getTime();
  // 입력을 바꾸지 않도록 복사 후 최신순 정렬
  const at = (n: NotifLike) => Math.min(ts(n.createdAt), cap);
  const sorted = [...list].sort((a, b) => at(b) - at(a));
  const open = new Map<string, { anchor: number; g: NotifGroup }>();
  const groups: NotifGroup[] = [];
  for (const n of sorted) {
    const key = `${n.type}|${n.link ?? ""}`;
    const t = at(n);
    let cur = open.get(key);
    // 묶음의 가장 새 항목 기준 24시간 이내(경계 포함)만 같은 묶음
    if (!cur || cur.anchor - t > DAY_MS) {
      const g: NotifGroup = { key, type: n.type, link: n.link ?? null, count: 0, unread: 0, latestAt: new Date(t).toISOString(), ids: [], sample: [] };
      cur = { anchor: t, g };
      open.set(key, cur);
      groups.push(g);
    }
    cur.g.count++;
    if (!n.readAt) cur.g.unread++;
    cur.g.ids.push(n.id);
    if (cur.g.sample.length < 3) cur.g.sample.push(n.title);
  }
  return groups.sort((a, b) => ts(b.latestAt) - ts(a.latestAt));
}

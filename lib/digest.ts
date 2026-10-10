import { prisma } from "@/lib/prisma";
import { getSlackConfig } from "@/lib/slack";
import { fireNotif } from "@/lib/notify";
import { isoWeekKey } from "@/lib/metrics";
import { isOpenStatus } from "@/lib/taskFilter";
import { statusOf, titleOf, type PropLite } from "@/lib/notify.pure";
import { buildAccessIndex, pageAccess } from "@/lib/pageAccess";
import { archivedPageIds } from "@/lib/pageArchive";
import { log } from "@/lib/log";

/* =====================================================================
   프로젝트 주간 다이제스트 (F6) — 한 주(워커: Asia/Seoul 월~일) 또는 지난 N일 동안 한 프로젝트에서 일어난 일을
   Slack 한 메시지로 요약한다. 워커가 월요일 9시대에 자동 발송하고,
   GET/POST /api/digest 와 `pnpm ws digest weekly` 가 같은 함수를 쓴다.

   ## 출처 선택 — 왜 Activity 가 아니라 원본 테이블인가
   Activity 는 projectId 가 없고(워크스페이스 단위 피드), 태스크는 "updated" 한
   줄로만 남아 **무엇이 바뀌었는지(상태 전이)** 를 모른다. 그래서 프로젝트별
   "완료한 태스크" 를 Activity 로는 만들 수 없다. 대신:
     - 태스크(tasksDone): 프로젝트 보드의 DbRow 중 **기간 안에 바뀐(updatedAt) 행 중
       지금 상태가 닫힘**(lib/taskFilter 규칙 — 완료·취소 등)인 것. "기간 안에 닫힌 행" 이
       아니다 — 상태 전이 이력 테이블이 없어서다. updatedAt 은 어떤 편집에도 갱신되므로,
       지난주에 닫혀 이번 주에 메모만 고친 행도 잡힌다(과대 집계 쪽 오차).
       이력 테이블이 생기면 그걸로 바꾼다.
     - 결정: accepted 이고 decidedAt 이 기간 안. 레슨: createdAt 이 기간 안.
     - 문서: kind=doc·삭제/보관 아님·행 본문 페이지 아님. createdAt 이 기간 안이면
       새 문서, 아니면서 updatedAt 이 기간 안이면 수정. **한계**: Page.updatedAt 은 본문
       편집뿐 아니라 이동·정렬(parentId·position 변경)에도 오르므로, 트리에서 옮기기만 한
       문서도 "수정" 으로 센다.
     - 승인: respondedAt 이 기간 안인 approved/rejected 수 + 지금 pending 수.

   ## 권한(D3)
   보드·문서는 `canSee(pageId)` 로 거른다. API 는 요청자 색인을, Slack 발송은
   "부여 없는 일반 멤버" 가상 뷰어 색인을 넘긴다 — 채널은 누가 읽을지 모르므로
   잠긴(restricted) 페이지는 제목조차 보내지 않는다(lib/notify loadBoard 와 같은 태도).

   ## 보관(F2)
   쿼리의 archivedAt:null 은 그 페이지 자신만 본다. 보관은 조상 기반이라(lib/pageArchive)
   보관된 부모 아래 문서·보드는 canSee 에서 걸러야 한다 — channelCanSee 는 스스로,
   API 는 excludeArchived 로 감싼다.
   ===================================================================== */

type Db = Pick<typeof prisma, "project" | "page" | "dbProperty" | "dbRow" | "decision" | "lesson" | "approval">;

export type Digest = {
  project: { id: string; name: string };
  range: { since: string; until: string };
  tasksDone: { title: string; boardTitle: string }[];
  decisions: { title: string }[];
  lessons: { title: string }[];
  docs: { created: number; updated: number; titles: string[] };
  approvals: { approved: number; rejected: number; pending: number };
};

const DOC_TITLES_MAX = 5;

export async function collectDigest(
  db: Db,
  opts: { workspaceId: string; projectId: string; since: Date; until: Date; canSee: (pageId: string) => boolean },
): Promise<Digest | null> {
  const { workspaceId, projectId, since, until, canSee } = opts;
  const project = await db.project.findFirst({ where: { id: projectId, workspaceId }, select: { id: true, name: true } });
  if (!project) return null;
  const range = { gte: since, lt: until };

  const [boards, docs, decisions, lessons, responded, pending] = await Promise.all([
    db.page.findMany({
      where: { workspaceId, projectId, kind: "database", deletedAt: null, archivedAt: null },
      select: { id: true, title: true },
    }),
    db.page.findMany({
      where: { workspaceId, projectId, kind: "doc", deletedAt: null, archivedAt: null, rowBacklink: { is: null }, updatedAt: range },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    }),
    db.decision.findMany({
      where: { workspaceId, projectId, status: "accepted", decidedAt: range },
      orderBy: { decidedAt: "asc" },
      select: { title: true },
    }),
    db.lesson.findMany({
      where: { workspaceId, projectId, createdAt: range },
      orderBy: { createdAt: "asc" },
      select: { title: true },
    }),
    db.approval.groupBy({
      by: ["status"],
      where: { workspaceId, projectId, status: { in: ["approved", "rejected"] }, respondedAt: range },
      _count: { _all: true },
    }),
    db.approval.count({ where: { workspaceId, projectId, status: "pending" } }),
  ]);

  // 태스크 — 볼 수 있는 보드만, 기간 안에 바뀐 행 중 지금 닫힌 것
  const visibleBoards = boards.filter((b) => canSee(b.id));
  const tasksDone: Digest["tasksDone"] = [];
  if (visibleBoards.length > 0) {
    const boardIds = visibleBoards.map((b) => b.id);
    const [props, rows] = await Promise.all([
      db.dbProperty.findMany({
        where: { databasePageId: { in: boardIds } },
        orderBy: { position: "asc" },
        select: { id: true, name: true, type: true, config: true, databasePageId: true },
      }),
      db.dbRow.findMany({
        where: { databasePageId: { in: boardIds }, updatedAt: range },
        orderBy: { updatedAt: "asc" },
        select: { databasePageId: true, props: true, updatedAt: true },
      }),
    ]);
    const propsByBoard = new Map<string, PropLite[]>();
    for (const p of props) {
      const lite: PropLite = { id: p.id, name: p.name, type: String(p.type), config: p.config };
      propsByBoard.set(p.databasePageId, [...(propsByBoard.get(p.databasePageId) ?? []), lite]);
    }
    const boardTitle = new Map(visibleBoards.map((b) => [b.id, b.title]));
    for (const r of rows) {
      const bp = propsByBoard.get(r.databasePageId) ?? [];
      const rp = (r.props ?? {}) as Record<string, unknown>;
      const status = statusOf(bp, rp);
      if (status === null || isOpenStatus(status)) continue; // 상태가 없으면 '닫힘' 으로 볼 근거가 없다
      tasksDone.push({ title: titleOf(bp, rp), boardTitle: boardTitle.get(r.databasePageId) ?? "" });
    }
  }

  const visibleDocs = docs.filter((d) => canSee(d.id));
  const created = visibleDocs.filter((d) => d.createdAt >= since);
  const updated = visibleDocs.filter((d) => d.createdAt < since);
  const count = (s: string) => responded.find((g) => g.status === s)?._count._all ?? 0;

  return {
    project,
    range: { since: since.toISOString(), until: until.toISOString() },
    tasksDone,
    decisions,
    lessons,
    docs: {
      created: created.length,
      updated: updated.length,
      titles: [...created, ...updated].slice(0, DOC_TITLES_MAX).map((d) => d.title),
    },
    approvals: { approved: count("approved"), rejected: count("rejected"), pending },
  };
}

/** 발송 여부 판단용 "활동" 건수 — 대기 중 승인은 상태일 뿐 이번 주 활동이 아니라 뺀다. */
export function digestItemCount(d: Digest): number {
  return d.tasksDone.length + d.decisions.length + d.lessons.length + d.docs.created + d.docs.updated + d.approvals.approved + d.approvals.rejected;
}

/* ── 시간대·주 단위 창 ── */

/**
 * 다이제스트의 날짜 기준 시간대. 서버 로컬 시각(TZ 환경변수)에 기대지 않는다 — 맥미니·컨테이너·CI 의
 * TZ 가 달라도 "월요일 9시"·"MM/DD" 가 같은 뜻이 되게.
 */
export const DIGEST_TZ = "Asia/Seoul";

type ZonedParts = { y: number; mo: number; d: number; h: number; mi: number; s: number; wd: number };
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** 한 순간을 tz 의 벽시계 성분으로(wd: 0=일 … 6=토). */
export function zonedParts(t: Date, tz: string = DIGEST_TZ): ZonedParts {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  const parts = f.formatToParts(t);
  const g = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return { y: +g("year"), mo: +g("month"), d: +g("day"), h: +g("hour") % 24, mi: +g("minute"), s: +g("second"), wd: WEEKDAY[g("weekday")] ?? 0 };
}

/** tz 에서 그 날짜(y-mo-d)의 00:00 이 되는 순간. 오프셋을 두 번 재 DST 경계도 맞춘다. */
function zonedMidnight(y: number, mo: number, d: number, tz: string): Date {
  const wall = Date.UTC(y, mo - 1, d);
  const offset = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(t / 1000) * 1000;
  };
  const first = wall - offset(wall);
  return new Date(wall - offset(first));
}

/**
 * `now` 직전에 **끝난** 주 — tz 기준 월요일 00:00 ~ 다음 월요일 00:00(until 은 배타).
 * 워커는 그 주가 끝난 다음 월요일 9시대에 돌므로 "지난주 월~일" 이 된다. now 가 월요일 00:00 정각이면
 * 그 순간이 until 이다. label 은 "MM/DD ~ MM/DD"(끝은 일요일).
 */
export function weekRange(now: Date, tz: string = DIGEST_TZ): { since: Date; until: Date; label: string } {
  const p = zonedParts(now, tz);
  const monday = new Date(Date.UTC(p.y, p.mo - 1, p.d - ((p.wd + 6) % 7)));
  const prev = new Date(monday.getTime() - 7 * 86_400_000);
  const until = zonedMidnight(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate(), tz);
  const since = zonedMidnight(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), tz);
  return { since, until, label: rangeLabel({ since: since.toISOString(), until: until.toISOString() }, tz) };
}

const mmdd = (t: Date, tz: string) => {
  const p = zonedParts(t, tz);
  return `${String(p.mo).padStart(2, "0")}/${String(p.d).padStart(2, "0")}`;
};
/** "MM/DD ~ MM/DD"(tz 기준). until 은 배타 경계라, tz 자정 정각이면 하루 전 날짜를 보인다. */
export function rangeLabel(r: Digest["range"], tz: string = DIGEST_TZ): string {
  const u = new Date(r.until);
  const up = zonedParts(u, tz);
  const shown = up.h === 0 && up.mi === 0 && up.s === 0 && u.getUTCMilliseconds() === 0 ? new Date(u.getTime() - 1) : u;
  return `${mmdd(new Date(r.since), tz)} ~ ${mmdd(shown, tz)}`;
}

/* ── 렌더 ── */

const SLACK_MAX = 2500;
const PARTIAL_MARKER_ERROR = "partial_delivery";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/**
 * 사용자 문자열(프로젝트·태스크·보드·결정·레슨·문서 제목)을 mrkdwn 에 넣을 때.
 * `&<>` 는 Slack 규칙대로 엔티티로 바꾼다. 서식 기호 `* _ ~` 는 **단어 경계**(제목 처음·끝, 공백·문장부호 옆)에 있을 때만
 * 전각 문자(＊ ＿ ～)로 바꾼다 — 그때만 Slack 이 서식으로 파싱하고 우리 머리글의 굵게/기울임과 짝을 이룰 수 있다.
 * `snake_case` 처럼 글자 사이에 낀 기호는 그대로 둬 읽기·검색이 유지된다. 백틱은 어디서든 코드로 파싱되므로 항상 전각.
 * 제로폭 공백은 눈에 안 보여 복사·검색을 망치고 Slack 파서에 따라 효과가 달라 쓰지 않는다.
 * 줄바꿈은 공백으로 — 글머리 한 줄이 둘로 쪼개지지 않게.
 */
const MRKDWN_FULLWIDTH: Record<string, string> = { "*": "＊", _: "＿", "~": "～", "`": "｀" };
export function escMrkdwn(s: string): string {
  const flat = esc(s.replace(/\s*[\r\n]+\s*/g, " "));
  return flat
    .replace(/`/g, "｀")
    .replace(/[*_~]/g, (c, i: number, str: string) => {
      const prev = i > 0 ? str[i - 1] : "";
      const next = i < str.length - 1 ? str[i + 1] : "";
      const isWord = (ch: string) => /[\p{L}\p{N}]/u.test(ch);
      // 양옆이 모두 글자·숫자면 단어 안쪽 — 서식으로 안 읽힌다
      return isWord(prev) && isWord(next) ? c : MRKDWN_FULLWIDTH[c];
    });
}

const ENTITIES = ["&amp;", "&lt;", "&gt;"];
/**
 * max 자 이하로 자르고 "…" 를 붙인다. 엔티티(&amp; &lt; &gt;) 한가운데나 서로게이트 쌍(이모지) 사이에서
 * 자르지 않는다 — 걸치면 그 앞에서 자른다.
 */
export function truncateMrkdwn(s: string, max: number = SLACK_MAX): string {
  if (s.length <= max) return s;
  let cut = max - 1; // "…" 자리
  for (let i = Math.max(0, cut - 4); i < cut; i++) {
    const ent = ENTITIES.find((e) => s.startsWith(e, i));
    if (ent && i + ent.length > cut) {
      cut = i;
      break;
    }
  }
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return s.slice(0, cut) + "…";
}

function bulletList(items: string[], cap: number): string[] {
  const lines = items.slice(0, cap).map((s) => `• ${s}`);
  if (items.length > cap) lines.push(`… 외 ${items.length - cap}건`);
  return lines;
}

function slackText(d: Digest, cap: number): string {
  const out: string[] = [`📊 *${escMrkdwn(d.project.name)}* 주간 다이제스트 (${rangeLabel(d.range)})`];
  if (digestItemCount(d) === 0) {
    out.push("이번 주 기록된 활동이 없습니다.");
    if (d.approvals.pending > 0) out.push(`🗳 대기 중인 승인 ${d.approvals.pending}건`);
    return out.join("\n");
  }
  if (d.tasksDone.length) {
    out.push("", `*✅ 완료한 태스크 ${d.tasksDone.length}건*`);
    out.push(...bulletList(d.tasksDone.map((t) => `${escMrkdwn(t.title)}${t.boardTitle ? ` _(${escMrkdwn(t.boardTitle)})_` : ""}`), cap));
  }
  if (d.decisions.length) {
    out.push("", `*🧭 결정 ${d.decisions.length}건*`);
    out.push(...bulletList(d.decisions.map((x) => escMrkdwn(x.title)), cap));
  }
  if (d.lessons.length) {
    out.push("", `*💡 레슨 ${d.lessons.length}건*`);
    out.push(...bulletList(d.lessons.map((x) => escMrkdwn(x.title)), cap));
  }
  if (d.docs.created + d.docs.updated > 0) {
    out.push("", `*📝 문서* 새 문서 ${d.docs.created} · 수정 ${d.docs.updated}`);
    const total = d.docs.created + d.docs.updated;
    const lines = d.docs.titles.slice(0, cap).map((t) => `• ${escMrkdwn(t)}`);
    if (total > lines.length) lines.push(`… 외 ${total - lines.length}건`);
    out.push(...lines);
  }
  const a = d.approvals;
  if (a.approved + a.rejected + a.pending > 0) out.push("", `*🗳 승인* 승인 ${a.approved} · 거부 ${a.rejected} · 대기 ${a.pending}`);
  return out.join("\n");
}

/** Slack mrkdwn — 2,500자 이하. 넘으면 구역당 항목 수를 줄여 가며 맞추고, 그래도 넘으면 엔티티를 깨지 않게 자른다. */
export function renderDigest(d: Digest): string {
  for (const cap of [10, 5, 3, 1, 0]) {
    const t = slackText(d, cap);
    if (t.length <= SLACK_MAX) return t;
  }
  return truncateMrkdwn(slackText(d, 0), SLACK_MAX);
}

/** dry-run·문서용 마크다운. 활동이 있으면 구성 비율을 mermaid pie 로 함께 싣는다(팀 문서 관례). */
export function renderDigestMarkdown(d: Digest): string {
  const out: string[] = [`# ${d.project.name} 주간 다이제스트`, "", `기간: ${rangeLabel(d.range)} (${d.range.since} ~ ${d.range.until})`, ""];
  if (digestItemCount(d) === 0) {
    out.push("이번 주 기록된 활동이 없습니다.");
    if (d.approvals.pending > 0) out.push("", `대기 중인 승인 ${d.approvals.pending}건`);
    return out.join("\n");
  }
  const slices: [string, number][] = [
    ["완료한 태스크", d.tasksDone.length],
    ["결정", d.decisions.length],
    ["레슨", d.lessons.length],
    ["문서", d.docs.created + d.docs.updated],
    ["승인 처리", d.approvals.approved + d.approvals.rejected],
  ];
  out.push("```mermaid", "pie title 이번 주 활동 구성", ...slices.filter(([, n]) => n > 0).map(([k, n]) => `  "${k}" : ${n}`), "```", "");
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    out.push(`## ${title} (${items.length})`, ...items.map((s) => `- ${s}`), "");
  };
  section("완료한 태스크", d.tasksDone.map((t) => (t.boardTitle ? `${t.title} — ${t.boardTitle}` : t.title)));
  section("결정", d.decisions.map((x) => x.title));
  section("레슨", d.lessons.map((x) => x.title));
  if (d.docs.created + d.docs.updated > 0) {
    out.push(`## 문서 (새 문서 ${d.docs.created} · 수정 ${d.docs.updated})`, ...d.docs.titles.map((t) => `- ${t}`), "");
  }
  const a = d.approvals;
  if (a.approved + a.rejected + a.pending > 0) out.push(`## 승인`, `- 승인 ${a.approved} · 거부 ${a.rejected} · 대기 ${a.pending}`, "");
  return out.join("\n").trimEnd();
}

/* ── 채널 발송 ── */

/**
 * 채널용 가시성 판정 — "부여가 하나도 없는 일반 멤버(editor)" 가 볼 수 있는 페이지만 true.
 * 실제 사용자 id 와 겹치지 않는 가짜 id 라 작성자 예외도 걸리지 않는다.
 */
export async function channelCanSee(workspaceId: string): Promise<(pageId: string) => boolean> {
  const [pages, projects] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId },
      select: { id: true, parentId: true, projectId: true, createdById: true, visibility: true, archivedAt: true },
    }),
    prisma.project.findMany({ where: { workspaceId }, select: { id: true, visibility: true } }),
  ]);
  const idx = buildAccessIndex({
    viewer: { userId: "__slack_channel__", teamId: null, role: "editor" },
    pages,
    projects,
    pageGrants: [],
    projectGrants: [],
  });
  // 보관된 조상 아래 페이지도 뺀다(F2) — archivedAt 은 자식 행에 전파되지 않는다.
  const archived = archivedPageIds(pages.map((p) => ({ id: p.id, parentId: p.parentId, archivedAt: p.archivedAt ?? null })));
  return (id) => !archived.has(id) && pageAccess(idx, id) !== "none";
}

/** canSee 를 "보관된 조상 아래가 아님" 조건으로 감싼다(API 경로용 — 페이지 한 번 조회). */
export async function excludeArchived(workspaceId: string, canSee: (pageId: string) => boolean): Promise<(pageId: string) => boolean> {
  const pages = await prisma.page.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, parentId: true, archivedAt: true },
  });
  const archived = archivedPageIds(pages);
  return (id) => !archived.has(id) && canSee(id);
}

/** 워커 발송 창: tz(기본 Asia/Seoul) 기준 월요일 09:00–09:59. 서버 TZ 와 무관. */
export function inDigestWindow(now: Date, tz: string = DIGEST_TZ): boolean {
  const p = zonedParts(now, tz);
  return p.wd === 1 && p.h === 9;
}

/** tz 날짜 기준 ISO 주 키(발송한 주) — UTC 로 바로 재면 KST 월요일 9시 이전/이후가 다른 주가 될 수 있다. */
export function digestWeekKey(now: Date, tz: string = DIGEST_TZ): string {
  const p = zonedParts(now, tz);
  return isoWeekKey(new Date(Date.UTC(p.y, p.mo - 1, p.d)));
}

export const digestMarkerRef = (projectId: string, weekKey: string) => `digest:${projectId}:${weekKey}`;

const DAY_MS = 86_400_000;

/**
 * 워커 주간 발송. Slack 이 연결된 워크스페이스마다, 보관·잠금 아닌 프로젝트 중 **지난주(weekRange —
 * Asia/Seoul 월 00:00 ~ 월 00:00)** 활동이 1건 이상인 곳에 다이제스트를 보낸다.
 *
 * ## 채널 — NotifRule(weekly_digest) → 기본 채널
 * fireNotif(…, "weekly_digest", …, projectId) 로 보낸다: 그 프로젝트 규칙이 있으면 그 채널(들), 없으면
 * 전역 규칙(projectId=null), 규칙이 하나도 없으면 SlackInstall 기본 채널(fallbackToDefault — 규칙을
 * 만들기 전의 종전 동작). 보낼 곳이 없으면(규칙·기본 채널 모두 없음) 건너뛰고 마커도 남기지 않는다.
 *
 * ## 중복 방지 — NotifLog 마커
 * notifyTasksDue 의 due_marker 와 같은 방식: NotifLog(kind=digest_marker, text=digest:<프로젝트>:<주>).
 * Activity 를 쓰지 않은 이유: recordActivity 는 사람/에이전트 Ctx(actor)를 요구하는데
 * 워커에는 없고, 활동 피드에 시스템 줄이 섞인다. 마커는 발송 실패여도 남긴다 —
 * 그렇지 않으면 채널 오류 때 9시대 내내 매분 재시도한다(실패는 NotifLog 의 failed 행으로 보인다).
 * 워커 쪽의 메모리 Set 은 같은 주에 이 함수를 다시 부르지 않게 하는 1차 가드일 뿐이고,
 * 재기동 뒤에도 안전한 건 이 마커 덕이다.
 */
export async function sendWeeklyDigests(
  now: Date = new Date(),
  tz: string = DIGEST_TZ,
): Promise<{ weekKey: string; sent: number; failed: number; skipped: number }> {
  const weekKey = digestWeekKey(now, tz);
  const { since, until } = weekRange(now, tz);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  // 한 워크스페이스·프로젝트의 예외가 나머지 발송을 막지 않게 격리한다(실패는 failed 로 세고 로그).
  for (const w of workspaces) {
    let projects: { id: string; name: string }[];
    let canSee: (pageId: string) => boolean;
    try {
      const cfg = await getSlackConfig(w.id).catch(() => null);
      if (!cfg) continue;
      // 기본 채널도 weekly_digest 채널 규칙도 없으면 보낼 곳이 없다 — 프로젝트 수집 전에 통째로 건너뛴다.
      if (!cfg.defaultChannelId?.trim()) {
        const rules = await prisma.notifRule.count({ where: { workspaceId: w.id, event: "weekly_digest", enabled: true, target: "channel" } });
        if (rules === 0) continue;
      }
      projects = await prisma.project.findMany({
        where: { workspaceId: w.id, archivedAt: null, visibility: "inherit" },
        orderBy: { position: "asc" },
        select: { id: true, name: true },
      });
      if (projects.length === 0) continue;
      canSee = await channelCanSee(w.id);
    } catch (e) {
      failed++;
      log.warn("digest.workspace_failed", { msg: "주간 다이제스트 워크스페이스 처리 실패", workspaceId: w.id, err: e });
      continue;
    }
    for (const p of projects) {
      try {
        const ref = digestMarkerRef(p.id, weekKey);
        // createdAt 하한 — [workspaceId, createdAt] 인덱스를 타게(주 키라 8일이면 충분)
        const dup = await prisma.notifLog.findFirst({
          where: {
            workspaceId: w.id,
            kind: "digest_marker",
            text: ref,
            createdAt: { gte: new Date(now.getTime() - 8 * DAY_MS) },
            // 완료("sent") 또는 일부만 나간 발송("partial_delivery" 실패 마커 — 재시도하면 이중 게시)만 중복으로 본다.
            // 아무 데도 못 보낸 발송은 마커를 남기지 않으므로 다음 tick 에 재시도된다.
            OR: [{ state: "sent" }, { state: "failed", error: PARTIAL_MARKER_ERROR }],
          },
          select: { id: true },
        });
        if (dup) {
          skipped++;
          continue;
        }
        const d = await collectDigest(prisma, { workspaceId: w.id, projectId: p.id, since, until, canSee });
        if (!d || digestItemCount(d) === 0) {
          skipped++;
          continue;
        }
        const r = await fireNotif(w.id, "weekly_digest", renderDigest(d), p.id, { kind: "digest", fallbackToDefault: true });
        if (r.noTarget) {
          // 이 프로젝트엔 규칙도 기본 채널도 없다(다른 프로젝트 규칙만 있는 워크스페이스) — 실패가 아니다.
          skipped++;
          continue;
        }
        const ok = r.delivered > 0 && r.failed === 0;
        if (ok) sent++;
        else failed++;
        // 아무 곳에도 못 보냈으면(delivered 0) 마커를 쓰지 않는다 — 9시대 다음 tick 이 재시도한다.
        if (r.delivered === 0) continue;
        // 마커 쓰기 실패는 로그만 — 함수는 정상 반환한다. 전부 성공이면 "sent", 일부만 나갔으면(재시도 시 이중 게시)
        // "failed"+partial_delivery 로 남겨 재시도를 막는다.
        await prisma.notifLog
          .create({ data: { workspaceId: w.id, channel: "-", text: ref, kind: "digest_marker", state: ok ? "sent" : "failed", error: ok ? null : PARTIAL_MARKER_ERROR } })
          .catch((e: unknown) => log.warn("digest.marker_write_failed", { msg: "다이제스트 중복 방지 마커 기록 실패", workspaceId: w.id, projectId: p.id, err: e }));
      } catch (e) {
        failed++;
        log.warn("digest.project_failed", { msg: "주간 다이제스트 프로젝트 처리 실패", workspaceId: w.id, projectId: p.id, err: e });
      }
    }
  }
  return { weekKey, sent, failed, skipped };
}

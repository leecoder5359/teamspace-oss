import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    workspace: { findMany: vi.fn() },
    project: { findMany: vi.fn(), findFirst: vi.fn() },
    page: { findMany: vi.fn() },
    dbProperty: { findMany: vi.fn() },
    dbRow: { findMany: vi.fn() },
    decision: { findMany: vi.fn() },
    lesson: { findMany: vi.fn() },
    approval: { groupBy: vi.fn(), count: vi.fn() },
    notifLog: { findFirst: vi.fn(), create: vi.fn() },
    notifRule: { count: vi.fn() },
  },
}));
vi.mock("@/lib/slack", () => ({ getSlackConfig: vi.fn() }));
vi.mock("@/lib/notify", () => ({ fireNotif: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { prisma } from "@/lib/prisma";
import { getSlackConfig } from "@/lib/slack";
import { fireNotif } from "@/lib/notify";
import { log } from "@/lib/log";
import {
  channelCanSee,
  excludeArchived,
  collectDigest,
  digestItemCount,
  digestMarkerRef,
  digestWeekKey,
  escMrkdwn,
  inDigestWindow,
  rangeLabel,
  renderDigest,
  truncateMrkdwn,
  weekRange,
  renderDigestMarkdown,
  sendWeeklyDigests,
  type Digest,
} from "./digest";

const m = (f: unknown) => f as Mock;
const since = new Date("2026-10-02T00:00:00Z");
const until = new Date("2026-10-09T00:00:00Z");
const inRange = new Date("2026-10-05T00:00:00Z");
const before = new Date("2026-09-01T00:00:00Z");

const STATUS = { id: "ps", name: "상태", type: "select", config: { options: [{ id: "o1", name: "진행중" }, { id: "o2", name: "완료" }, { id: "o3", name: "취소" }] } };
const TITLE = { id: "pt", name: "제목", type: "text", config: {} };

function fixture() {
  m(prisma.project.findFirst).mockResolvedValue({ id: "p1", name: "TeamSpace" });
  m(prisma.page.findMany).mockImplementation(async (args: { where: { kind: string } }) =>
    args.where.kind === "database"
      ? [{ id: "b1", title: "개발 보드" }, { id: "b2", title: "잠긴 보드" }]
      : [
          { id: "d1", title: "새 설계", createdAt: inRange, updatedAt: inRange },
          { id: "d2", title: "고친 문서", createdAt: before, updatedAt: inRange },
          { id: "d3", title: "잠긴 문서", createdAt: inRange, updatedAt: inRange },
        ],
  );
  m(prisma.dbProperty.findMany).mockResolvedValue([
    { ...TITLE, databasePageId: "b1" },
    { ...STATUS, databasePageId: "b1" },
  ]);
  m(prisma.dbRow.findMany).mockResolvedValue([
    { databasePageId: "b1", props: { pt: "로그인 고치기", ps: "o2" }, updatedAt: inRange },
    { databasePageId: "b1", props: { pt: "진행 중 일", ps: "o1" }, updatedAt: inRange },
    { databasePageId: "b1", props: { pt: "접은 일", ps: "o3" }, updatedAt: inRange },
    { databasePageId: "b1", props: { pt: "상태 없음" }, updatedAt: inRange },
  ]);
  m(prisma.decision.findMany).mockResolvedValue([{ title: "배포는 금요일 금지" }]);
  m(prisma.lesson.findMany).mockResolvedValue([{ title: "마이그 먼저" }]);
  m(prisma.approval.groupBy).mockResolvedValue([
    { status: "approved", _count: { _all: 2 } },
    { status: "rejected", _count: { _all: 1 } },
  ]);
  m(prisma.approval.count).mockResolvedValue(3);
}

const canSee = (id: string) => id !== "b2" && id !== "d3";

describe("collectDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture();
  });

  it("닫힌 상태로 바뀐 태스크·결정·레슨·문서·승인을 모은다(볼 수 없는 보드·문서 제외)", async () => {
    const d = await collectDigest(prisma, { workspaceId: "w1", projectId: "p1", since, until, canSee });
    expect(d).not.toBeNull();
    expect(d!.project).toEqual({ id: "p1", name: "TeamSpace" });
    expect(d!.tasksDone).toEqual([
      { title: "로그인 고치기", boardTitle: "개발 보드" },
      { title: "접은 일", boardTitle: "개발 보드" },
    ]);
    // 잠긴 보드 b2 는 행 조회 대상에서 빠진다
    expect(m(prisma.dbRow.findMany).mock.calls[0][0].where.databasePageId).toEqual({ in: ["b1"] });
    expect(d!.decisions).toEqual([{ title: "배포는 금요일 금지" }]);
    expect(d!.lessons).toEqual([{ title: "마이그 먼저" }]);
    expect(d!.docs).toEqual({ created: 1, updated: 1, titles: ["새 설계", "고친 문서"] });
    expect(d!.approvals).toEqual({ approved: 2, rejected: 1, pending: 3 });
    expect(d!.range).toEqual({ since: since.toISOString(), until: until.toISOString() });
    expect(digestItemCount(d!)).toBe(2 + 1 + 1 + 2 + 3);
  });

  it("다른 워크스페이스·없는 프로젝트면 null", async () => {
    m(prisma.project.findFirst).mockResolvedValue(null);
    expect(await collectDigest(prisma, { workspaceId: "w1", projectId: "x", since, until, canSee })).toBeNull();
    expect(m(prisma.project.findFirst).mock.calls[0][0].where).toEqual({ id: "x", workspaceId: "w1" });
  });

  it("문서 제목은 5개까지", async () => {
    m(prisma.page.findMany).mockImplementation(async (args: { where: { kind: string } }) =>
      args.where.kind === "database" ? [] : Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, title: `문서${i}`, createdAt: inRange, updatedAt: inRange })),
    );
    const d = await collectDigest(prisma, { workspaceId: "w1", projectId: "p1", since, until, canSee: () => true });
    expect(d!.docs.created).toBe(8);
    expect(d!.docs.titles).toHaveLength(5);
    expect(d!.tasksDone).toEqual([]);
    expect(prisma.dbRow.findMany).not.toHaveBeenCalled(); // 보드 0개면 행 조회 생략
  });
});

const sample = (): Digest => ({
  project: { id: "p1", name: "TeamSpace" },
  range: { since: since.toISOString(), until: until.toISOString() },
  tasksDone: [{ title: "로그인 <고치기>", boardTitle: "개발 보드" }],
  decisions: [{ title: "배포는 금요일 금지" }],
  lessons: [],
  docs: { created: 1, updated: 0, titles: ["새 설계"] },
  approvals: { approved: 0, rejected: 0, pending: 0 },
});

describe("renderDigest", () => {
  it("한국어 mrkdwn, 빈 구역은 생략, Slack 특수문자 이스케이프", () => {
    const t = renderDigest(sample());
    expect(t).toContain("주간 다이제스트");
    expect(t).toContain("*TeamSpace*");
    expect(t).toContain("완료한 태스크 1건");
    expect(t).toContain("로그인 &lt;고치기&gt;");
    expect(t).toContain("결정 1건");
    expect(t).not.toContain("레슨");
    expect(t).not.toContain("승인");
  });

  it("2,500자를 넘지 않고 긴 목록은 '… 외 n건' 으로 접는다", () => {
    const d = sample();
    d.tasksDone = Array.from({ length: 200 }, (_, i) => ({ title: `아주 긴 태스크 제목 ${"가".repeat(30)} ${i}`, boardTitle: "개발 보드" }));
    d.decisions = Array.from({ length: 50 }, (_, i) => ({ title: `결정 ${i}` }));
    const t = renderDigest(d);
    expect(t.length).toBeLessThanOrEqual(2500);
    expect(t).toMatch(/… 외 \d+건/);
    expect(t).toContain("결정 50건"); // 구역 머리는 잘리지 않는다
  });

  it("빈 다이제스트도 렌더된다(활동 없음 안내)", () => {
    const d = sample();
    d.tasksDone = [];
    d.decisions = [];
    d.docs = { created: 0, updated: 0, titles: [] };
    expect(digestItemCount(d)).toBe(0);
    expect(renderDigest(d)).toContain("이번 주 기록된 활동이 없습니다");
  });
});

describe("renderDigestMarkdown", () => {
  it("구역 제목·목록과 mermaid 구성 그림을 담는다", () => {
    const md = renderDigestMarkdown(sample());
    expect(md).toContain("# TeamSpace 주간 다이제스트");
    expect(md).toContain("## 완료한 태스크 (1)");
    expect(md).toContain("- 로그인 <고치기> — 개발 보드");
    expect(md).toContain("```mermaid");
    expect(md).toContain("pie");
  });
  it("빈 다이제스트는 그림 없이 안내만", () => {
    const d = sample();
    d.tasksDone = [];
    d.decisions = [];
    d.docs = { created: 0, updated: 0, titles: [] };
    const md = renderDigestMarkdown(d);
    expect(md).not.toContain("mermaid");
    expect(md).toContain("기록된 활동이 없습니다");
  });
});

describe("발송 창·주 키 (Asia/Seoul 명시 — 서버 TZ 무관)", () => {
  it("Asia/Seoul 월요일 9시대만 true", () => {
    expect(inDigestWindow(new Date("2026-10-12T00:00:00Z"))).toBe(true); // 월 09:00 KST
    expect(inDigestWindow(new Date("2026-10-12T00:59:59Z"))).toBe(true);
    expect(inDigestWindow(new Date("2026-10-12T01:00:00Z"))).toBe(false); // 10:00
    expect(inDigestWindow(new Date("2026-10-11T23:59:00Z"))).toBe(false); // 08:59
    expect(inDigestWindow(new Date("2026-10-13T00:30:00Z"))).toBe(false); // 화
    // UTC 로는 월요일 9시지만 KST 로는 18시 — false
    expect(inDigestWindow(new Date("2026-10-12T09:00:00Z"))).toBe(false);
    // 다른 tz 를 넘기면 그 tz 기준
    expect(inDigestWindow(new Date("2026-10-12T09:00:00Z"), "UTC")).toBe(true);
  });
  it("주 키는 Asia/Seoul 날짜 기준 ISO 주, 마커 ref 는 프로젝트+주", () => {
    expect(digestWeekKey(new Date("2026-10-12T00:05:00Z"))).toBe("2026-W42");
    // UTC 로는 일요일(W41)이지만 KST 로는 이미 월요일 — W42
    expect(digestWeekKey(new Date("2026-10-11T16:00:00Z"))).toBe("2026-W42");
    expect(digestMarkerRef("p1", "2026-W42")).toBe("digest:p1:2026-W42");
  });
});

describe("weekRange (지난주 월 00:00 ~ 월 00:00, Asia/Seoul)", () => {
  it("월요일 9시대 → 지난주 월~일, KST 자정 경계(= 전날 15:00Z)", () => {
    const r = weekRange(new Date("2026-10-12T00:05:00Z")); // 월 09:05 KST
    expect(r.since.toISOString()).toBe("2026-10-04T15:00:00.000Z"); // 10/05 월 00:00 KST
    expect(r.until.toISOString()).toBe("2026-10-11T15:00:00.000Z"); // 10/12 월 00:00 KST
    expect(r.label).toBe("10/05 ~ 10/11");
  });
  it("주 중간·일요일 밤·월요일 자정 정각에서도 '직전에 끝난 주'", () => {
    const at = (iso: string) => weekRange(new Date(iso)).label;
    expect(at("2026-10-15T03:00:00Z")).toBe("10/05 ~ 10/11"); // 목
    expect(at("2026-10-18T14:59:59Z")).toBe("10/05 ~ 10/11"); // 일 23:59:59 KST
    expect(at("2026-10-18T15:00:00Z")).toBe("10/12 ~ 10/18"); // 월 00:00 KST 정각 — 그 순간이 until
    // UTC 로는 일요일이지만 KST 로는 월요일 01:00
    expect(weekRange(new Date("2026-10-18T16:00:00Z")).until.toISOString()).toBe("2026-10-18T15:00:00.000Z");
  });
  it("월·연 경계를 넘는다(12/28 월 ~ 01/03 일)", () => {
    const r = weekRange(new Date("2027-01-04T00:30:00Z"));
    expect(r.since.toISOString()).toBe("2026-12-27T15:00:00.000Z");
    expect(r.until.toISOString()).toBe("2027-01-03T15:00:00.000Z");
    expect(r.label).toBe("12/28 ~ 01/03");
  });
  it("길이는 정확히 7일, 다른 tz 도 받는다(DST 없는 UTC)", () => {
    const r = weekRange(new Date("2026-10-12T00:05:00Z"), "UTC");
    expect(r.since.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(r.until.getTime() - r.since.getTime()).toBe(7 * 86_400_000);
  });
  it("DST 가 있는 tz 도 현지 자정에 맞춘다(뉴욕 11/01 서머타임 종료 주)", () => {
    const r = weekRange(new Date("2026-11-03T15:00:00Z"), "America/New_York");
    expect(r.since.toISOString()).toBe("2026-10-26T04:00:00.000Z"); // EDT 자정
    expect(r.until.toISOString()).toBe("2026-11-02T05:00:00.000Z"); // EST 자정
    expect(r.label).toBe("10/26 ~ 11/01");
  });
  it("rangeLabel: 롤링 기간(자정 아님)은 끝 날짜를 그대로 보인다", () => {
    expect(rangeLabel({ since: "2026-10-02T03:00:00.000Z", until: "2026-10-09T03:00:00.000Z" })).toBe("10/02 ~ 10/09");
    expect(rangeLabel({ since: "2026-10-04T15:00:00.000Z", until: "2026-10-11T15:00:00.000Z" })).toBe("10/05 ~ 10/11");
  });
});

describe("mrkdwn 이스케이프·자르기", () => {
  it("&<> 는 엔티티, * _ ~ ` 는 전각으로, 줄바꿈은 공백으로", () => {
    expect(escMrkdwn("a & <b> *굵게* _기울임_ ~취소~ `코드`")).toBe("a &amp; &lt;b&gt; ＊굵게＊ ＿기울임＿ ～취소～ ｀코드｀");
    // 글자 사이에 낀 기호는 단어 안쪽이라 그대로 둔다
    expect(escMrkdwn("fix_snake_case a*b_c")).toBe("fix_snake_case a*b_c");
    expect(escMrkdwn("_lead trail_ x_ _y")).toBe("＿lead trail＿ x＿ ＿y");
    expect(escMrkdwn("두\n줄\r\n  제목")).toBe("두 줄 제목");
    expect(escMrkdwn("<!channel> <@U123>")).toBe("&lt;!channel&gt; &lt;@U123&gt;");
  });
  it("렌더된 다이제스트에서 제목의 서식 기호가 우리 머리글과 짝을 이루지 않는다", () => {
    const d = sample();
    d.project.name = "*Team*_Space_";
    d.tasksDone = [{ title: "fix_snake_case *now*", boardTitle: "보드_1" }];
    const t = renderDigest(d);
    expect(t).toContain("📊 *＊Team＊＿Space＿* 주간 다이제스트");
    expect(t).toContain("• fix_snake_case ＊now＊ _(보드_1)_");
  });
  it("truncateMrkdwn: max 이하면 그대로, 넘으면 '…' 포함 max 자", () => {
    expect(truncateMrkdwn("abc", 5)).toBe("abc");
    const t = truncateMrkdwn("x".repeat(20), 10);
    expect(t).toBe("x".repeat(9) + "…");
    expect(t.length).toBe(10);
  });
  it("truncateMrkdwn: 엔티티 한가운데서 자르지 않는다(&amp; &lt; &gt; 모든 위치)", () => {
    for (const ent of ["&amp;", "&lt;", "&gt;"]) {
      for (let pad = 0; pad < 8; pad++) {
        const s = "a".repeat(pad) + ent + "b".repeat(20);
        const t = truncateMrkdwn(s, 8);
        expect(t.length).toBeLessThanOrEqual(8);
        const body = t.slice(0, -1);
        // 남은 본문의 & 는 온전한 엔티티로 시작해야 한다(잘린 &am·&l 없음)
        const amp = body.lastIndexOf("&");
        if (amp >= 0) expect(body.slice(amp, amp + ent.length)).toBe(ent);
        else expect(body).toBe("a".repeat(Math.min(pad, 7)));
      }
    }
  });
  it("truncateMrkdwn: 서로게이트 쌍(이모지)을 쪼개지 않는다", () => {
    const t = truncateMrkdwn("abcd📊efgh", 6); // 컷 5 가 📊 의 가운데
    expect(t).toBe("abcd…");
  });
  it("renderDigest: 머리글만으로 2,500자를 넘어도 엔티티를 깨지 않고 자른다", () => {
    const d = sample();
    d.project.name = "&".repeat(1000); // &amp; ×1000 = 5,000자
    const t = renderDigest(d);
    expect(t.length).toBeLessThanOrEqual(2500);
    expect(t.endsWith("…")).toBe(true);
    expect(t.slice(0, -1)).toMatch(/(&amp;)+$/);
  });
});

describe("sendWeeklyDigests (워커)", () => {
  const now = new Date("2026-10-12T00:05:00Z"); // 월 09:05 KST
  beforeEach(() => {
    vi.clearAllMocks();
    fixture();
    m(prisma.workspace.findMany).mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
    m(getSlackConfig).mockImplementation(async (id: string) => (id === "w1" ? { source: "db", token: "x", defaultChannelId: "C1" } : null));
    m(prisma.project.findMany).mockResolvedValue([{ id: "p1", name: "TeamSpace" }]);
    m(prisma.notifLog.findFirst).mockResolvedValue(null);
    m(prisma.notifLog.create).mockResolvedValue({});
    m(prisma.notifRule.count).mockResolvedValue(0);
    m(fireNotif).mockResolvedValue({ delivered: 1, failed: 0 });
  });

  it("Slack 이 연결된 워크스페이스의 보관·잠금 아닌 프로젝트에 1회 발송 + 마커", async () => {
    // 채널용 색인: 잠긴 보드 b2·문서 d3 는 restricted
    m(prisma.page.findMany).mockImplementation(async (args: { where: { kind?: string }; select: Record<string, boolean> }) => {
      if (args.select?.visibility) {
        return [
          { id: "b1", parentId: null, projectId: "p1", createdById: "u", visibility: "inherit" },
          { id: "b2", parentId: null, projectId: "p1", createdById: "u", visibility: "restricted" },
          { id: "d1", parentId: null, projectId: "p1", createdById: "u", visibility: "inherit" },
          { id: "d2", parentId: null, projectId: "p1", createdById: "u", visibility: "inherit" },
          { id: "d3", parentId: "b2", projectId: "p1", createdById: "u", visibility: "inherit" },
        ];
      }
      return args.where.kind === "database"
        ? [{ id: "b1", title: "개발 보드" }, { id: "b2", title: "잠긴 보드" }]
        : [
            { id: "d1", title: "새 설계", createdAt: inRange, updatedAt: inRange },
            { id: "d3", title: "잠긴 문서", createdAt: inRange, updatedAt: inRange },
          ];
    });
    const r = await sendWeeklyDigests(now);
    expect(r).toEqual({ weekKey: "2026-W42", sent: 1, failed: 0, skipped: 0 });
    // 보관(archivedAt) · 잠긴(restricted) 프로젝트는 조회 단계에서 뺀다
    expect(m(prisma.project.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", archivedAt: null, visibility: "inherit" });
    // fireNotif 호출 모양 — weekly_digest 이벤트·프로젝트 id(규칙 선택)·kind digest·규칙 없으면 기본 채널
    expect(fireNotif).toHaveBeenCalledTimes(1);
    const [wsId, event, text, projectId, opts] = m(fireNotif).mock.calls[0];
    expect([wsId, event, projectId, opts]).toEqual(["w1", "weekly_digest", "p1", { kind: "digest", fallbackToDefault: true }]);
    expect(text).not.toContain("잠긴 문서");
    expect(text).toContain("(10/05 ~ 10/11)");
    // 수집 창은 지난주 월 00:00 ~ 월 00:00(KST)
    const opt = m(prisma.decision.findMany).mock.calls[0][0].where.decidedAt;
    expect(opt).toEqual({ gte: new Date("2026-10-04T15:00:00Z"), lt: new Date("2026-10-11T15:00:00Z") });
    expect(m(prisma.dbRow.findMany).mock.calls[0][0].where.databasePageId).toEqual({ in: ["b1"] });
    expect(m(prisma.notifLog.create).mock.calls[0][0].data).toMatchObject({ workspaceId: "w1", kind: "digest_marker", text: "digest:p1:2026-W42", state: "sent" });
  });

  it("이번 주 마커가 있으면 건너뛴다(재기동·중복 tick)", async () => {
    m(prisma.notifLog.findFirst).mockResolvedValue({ id: "x" });
    const r = await sendWeeklyDigests(now);
    expect(r.skipped).toBe(1);
    expect(fireNotif).not.toHaveBeenCalled();
  });

  it("항목이 하나도 없는 프로젝트는 보내지 않고 마커도 안 남긴다", async () => {
    m(prisma.page.findMany).mockResolvedValue([]);
    m(prisma.decision.findMany).mockResolvedValue([]);
    m(prisma.lesson.findMany).mockResolvedValue([]);
    m(prisma.approval.groupBy).mockResolvedValue([]);
    m(prisma.approval.count).mockResolvedValue(5); // 대기 건수만 있으면 '활동' 이 아니다
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 0, skipped: 1 });
    expect(fireNotif).not.toHaveBeenCalled();
    expect(prisma.notifLog.create).not.toHaveBeenCalled();
  });

  it("아무 곳에도 못 보낸 발송(delivered 0)은 마커를 남기지 않는다(다음 tick 재시도)", async () => {
    m(fireNotif).mockResolvedValue({ delivered: 0, failed: 1, error: "channel_not_found" });
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(prisma.notifLog.create).not.toHaveBeenCalled();
  });

  it("규칙 채널 일부만 실패하면 partial 실패 마커(재시도 시 이중 게시 방지)", async () => {
    m(fireNotif).mockResolvedValue({ delivered: 1, failed: 1, error: "is_archived" });
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 0, failed: 1 });
    expect(m(prisma.notifLog.create).mock.calls[0][0].data).toMatchObject({ state: "failed", error: "partial_delivery" });
  });

  it("보낼 곳이 없는 프로젝트(noTarget)는 건너뛰고 마커를 남기지 않는다", async () => {
    m(fireNotif).mockResolvedValue({ delivered: 0, failed: 0, noTarget: true });
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 0, failed: 0, skipped: 1 });
    expect(prisma.notifLog.create).not.toHaveBeenCalled();
  });

  it("기본 채널도 weekly_digest 규칙도 없으면 그 워크스페이스는 통째로 건너뛴다", async () => {
    m(getSlackConfig).mockResolvedValue({ source: "db", token: "x", defaultChannelId: null });
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 0, failed: 0 });
    expect(m(prisma.notifRule.count).mock.calls[0][0].where).toEqual({ workspaceId: "w1", event: "weekly_digest", enabled: true, target: "channel" });
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it("기본 채널이 없어도 weekly_digest 규칙이 있으면 보낸다", async () => {
    m(getSlackConfig).mockImplementation(async (id: string) => (id === "w1" ? { source: "db", token: "x", defaultChannelId: null } : null));
    m(prisma.notifRule.count).mockResolvedValue(1);
    m(prisma.page.findMany).mockResolvedValue([]);
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 1 });
    expect(fireNotif).toHaveBeenCalledTimes(1);
  });
});

describe("channelCanSee (부여 없는 가상 멤버 시점)", () => {
  beforeEach(() => vi.clearAllMocks());
  const page = (id: string, extra: Record<string, unknown> = {}) => ({
    id, parentId: null, projectId: "p1", createdById: "u", visibility: "inherit", archivedAt: null, ...extra,
  });

  it("잠긴 페이지·잠긴 조상 아래·잠긴 프로젝트·보관된 조상 아래는 false", async () => {
    m(prisma.page.findMany).mockResolvedValue([
      page("open"),
      page("locked", { visibility: "restricted" }),
      page("under-locked", { parentId: "locked" }),
      page("in-locked-project", { projectId: "p2" }),
      page("arch", { archivedAt: before }),
      page("under-arch", { parentId: "arch" }),
    ]);
    m(prisma.project.findMany).mockResolvedValue([
      { id: "p1", visibility: "inherit" },
      { id: "p2", visibility: "restricted" },
    ]);
    const see = await channelCanSee("w1");
    expect(m(prisma.page.findMany).mock.calls[0][0].select).toMatchObject({ archivedAt: true });
    expect(see("open")).toBe(true);
    expect(see("locked")).toBe(false);
    expect(see("under-locked")).toBe(false);
    expect(see("in-locked-project")).toBe(false);
    expect(see("arch")).toBe(false);
    expect(see("under-arch")).toBe(false);
  });
});

describe("excludeArchived (API 경로)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture();
  });

  it("보관된 부모 아래 문서는 다이제스트에서 빠진다", async () => {
    m(prisma.page.findMany).mockImplementation(async (args: { where: { kind?: string }; select: Record<string, boolean> }) => {
      if (args.select?.archivedAt) {
        return [
          { id: "folder", parentId: null, archivedAt: before },
          { id: "d1", parentId: "folder", archivedAt: null },
          { id: "d2", parentId: null, archivedAt: null },
        ];
      }
      return args.where.kind === "database"
        ? []
        : [
            { id: "d1", title: "보관 폴더 속 문서", createdAt: inRange, updatedAt: inRange },
            { id: "d2", title: "살아 있는 문서", createdAt: inRange, updatedAt: inRange },
          ];
    });
    const see = await excludeArchived("w1", () => true);
    expect(m(prisma.page.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", deletedAt: null });
    const d = await collectDigest(prisma, { workspaceId: "w1", projectId: "p1", since, until, canSee: see });
    expect(d!.docs.titles).toEqual(["살아 있는 문서"]);
    expect(d!.docs.created).toBe(1);
  });
});

describe("sendWeeklyDigests 격리·마커", () => {
  const now = new Date("2026-10-12T00:05:00Z");
  beforeEach(() => {
    vi.clearAllMocks();
    fixture();
    m(prisma.workspace.findMany).mockResolvedValue([{ id: "w1" }]);
    m(getSlackConfig).mockResolvedValue({ source: "db", token: "x", defaultChannelId: "C1" });
    m(prisma.project.findMany).mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select?.visibility ? [{ id: "p1", visibility: "inherit" }, { id: "p2", visibility: "inherit" }] : [{ id: "p1", name: "A" }, { id: "p2", name: "B" }],
    );
    m(prisma.notifLog.findFirst).mockResolvedValue(null);
    m(prisma.notifLog.create).mockResolvedValue({});
    m(fireNotif).mockResolvedValue({ delivered: 1, failed: 0 });
  });

  it("한 프로젝트 수집이 throw 해도 다음 프로젝트는 발송된다(failed 로 세고 로그)", async () => {
    m(prisma.project.findFirst).mockImplementation(async (args: { where: { id: string } }) => {
      if (args.where.id === "p1") throw new Error("boom");
      return { id: "p2", name: "B" };
    });
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 1, failed: 1 });
    expect(fireNotif).toHaveBeenCalledTimes(1);
    expect(m(prisma.notifLog.create).mock.calls[0][0].data.text).toBe(digestMarkerRef("p2", "2026-W42"));
    expect(log.warn).toHaveBeenCalledWith("digest.project_failed", expect.objectContaining({ workspaceId: "w1", projectId: "p1" }));
  });

  it("마커 조회는 최근 8일로 좁히고, 마커 쓰기 실패는 로그만 남기고 정상 반환한다", async () => {
    m(prisma.notifLog.create).mockRejectedValue(new Error("db down"));
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ weekKey: "2026-W42", sent: 2 });
    expect(m(prisma.notifLog.findFirst).mock.calls[0][0].where.createdAt).toEqual({ gte: new Date(now.getTime() - 8 * 86_400_000) });
    expect(log.warn).toHaveBeenCalledWith("digest.marker_write_failed", expect.objectContaining({ workspaceId: "w1", projectId: "p1" }));
  });

  it("내부 fireNotif 오류(delivered 0)면 마커를 쓰지 않아 다음 호출이 재시도한다", async () => {
    m(fireNotif).mockResolvedValueOnce({ delivered: 0, failed: 1, error: "channel_not_found" }).mockResolvedValue({ delivered: 1, failed: 0 });
    const first = await sendWeeklyDigests(now);
    expect(first).toMatchObject({ sent: 1, failed: 1 });
    // p1 은 실패(마커 없음), p2 는 성공(sent 마커)
    const markers = m(prisma.notifLog.create).mock.calls.map((c) => c[0].data);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ text: digestMarkerRef("p2", "2026-W42"), state: "sent" });
    // 중복 조회는 sent / partial 마커만 본다 — 아무 데도 못 보낸 발송은 막지 않는다
    const where = m(prisma.notifLog.findFirst).mock.calls[0][0].where;
    expect(where.OR).toEqual([{ state: "sent" }, { state: "failed", error: "partial_delivery" }]);
    m(fireNotif).mockClear();
    m(prisma.notifLog.create).mockClear();
    m(prisma.notifLog.findFirst).mockImplementation(async (a: { where: { text: string } }) => (a.where.text === digestMarkerRef("p2", "2026-W42") ? { id: "x" } : null));
    const second = await sendWeeklyDigests(now);
    expect(second).toMatchObject({ sent: 1, failed: 0, skipped: 1 });
    expect(fireNotif).toHaveBeenCalledTimes(1);
  });

  it("일부만 나간 발송은 failed 마커를 남기고 재시도하지 않는다", async () => {
    m(fireNotif).mockResolvedValue({ delivered: 1, failed: 1, error: "post_failed" });
    const r = await sendWeeklyDigests(now);
    expect(r).toMatchObject({ sent: 0, failed: 2 });
    for (const c of m(prisma.notifLog.create).mock.calls) expect(c[0].data).toMatchObject({ state: "failed", error: "partial_delivery" });
    expect(m(prisma.notifLog.create).mock.calls).toHaveLength(2);
  });

  it("전부 성공이면 sent 마커", async () => {
    await sendWeeklyDigests(now);
    for (const c of m(prisma.notifLog.create).mock.calls) expect(c[0].data).toMatchObject({ state: "sent", error: null });
  });
});

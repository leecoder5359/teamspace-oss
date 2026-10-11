import { describe, it, expect, vi, beforeEach } from "vitest";

/* 인메모리 가짜 prisma — 이 서비스가 쓰는 조회·쓰기만. $transaction 은 같은 객체로 콜백을 돌린다
   (롤백은 흉내 내지 않는다 — 실패 경로는 상태 표시만 확인). */
type Row = Record<string, unknown> & { id: string };
const { db, fake, ctr, sendApproval } = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string };
const db = {
  lessons: [] as Row[],
  runs: [] as Row[],
  approvals: [] as Row[],
  projects: [] as Row[],
  injections: [] as Row[],
  reads: [] as Row[],
};
const ctr = { seq: 0 };
const pick = (r: Row, select?: Record<string, boolean>) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r });
function match(r: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      const o = v as { in?: unknown[]; not?: unknown; gte?: Date };
      if (o.in) return o.in.includes(r[k]);
      if ("not" in o) return r[k] !== o.not;
      if (o.gte) return (r[k] as Date) >= o.gte;
    }
    return r[k] === v;
  });
}
const table = (rows: () => Row[], set: (r: Row[]) => void) => ({
  findMany: vi.fn(async (a: { where?: Record<string, unknown>; select?: Record<string, boolean> } = {}) => rows().filter((r) => match(r, a.where)).map((r) => pick(r, a.select))),
  findFirst: vi.fn(async (a: { where?: Record<string, unknown> }) => rows().find((r) => match(r, a.where)) ?? null),
  findUnique: vi.fn(async (a: { where: Record<string, unknown> }) => {
    const w = a.where as { id?: string; workspaceId_weekKey?: { workspaceId: string; weekKey: string } };
    if (w.workspaceId_weekKey) return rows().find((r) => r.workspaceId === w.workspaceId_weekKey!.workspaceId && r.weekKey === w.workspaceId_weekKey!.weekKey) ?? null;
    return rows().find((r) => r.id === w.id) ?? null;
  }),
  create: vi.fn(async (a: { data: Record<string, unknown> }) => {
    const r = rows();
    if (a.data.weekKey && r.some((x) => x.workspaceId === a.data.workspaceId && x.weekKey === a.data.weekKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
    if (a.data.id && r.some((x) => x.id === a.data.id)) throw Object.assign(new Error("unique"), { code: "P2002" });
    const row = { id: `id${++ctr.seq}`, createdAt: new Date(), updatedAt: new Date(), summary: "", ...a.data } as Row;
    set([...r, row]);
    return row;
  }),
  update: vi.fn(async (a: { where: { id: string }; data: Row }) => {
    const r = rows().find((x) => x.id === a.where.id);
    if (!r) throw new Error("not found");
    Object.assign(r, a.data, { updatedAt: new Date() });
    return r;
  }),
  updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Row }) => {
    const hit = rows().filter((r) => match(r, a.where));
    for (const r of hit) Object.assign(r, a.data);
    return { count: hit.length };
  }),
  deleteMany: vi.fn(async (a: { where: Record<string, unknown> }) => {
    const before = rows().length;
    set(rows().filter((r) => !match(r, a.where)));
    return { count: before - rows().length };
  }),
});
const fake = {
  lesson: table(() => db.lessons, (r) => (db.lessons = r)),
  lessonHygieneRun: table(() => db.runs, (r) => (db.runs = r)),
  approval: table(() => db.approvals, (r) => (db.approvals = r)),
  project: table(() => db.projects, (r) => (db.projects = r)),
  lessonInjection: table(() => db.injections, (r) => (db.injections = r)),
  lessonRead: table(() => db.reads, (r) => (db.reads = r)),
  workspace: { findMany: vi.fn(async () => [{ id: "w1" }]) },
  $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(fake)),
};
  const sendApproval = vi.fn<(w: string, a: Record<string, unknown>) => Promise<{ id: string; sent: boolean }>>(async () => ({ id: "ap1", sent: true }));
  return { db, fake, ctr, sendApproval };
});
vi.mock("@/lib/prisma", () => ({ prisma: fake }));
vi.mock("@/lib/approvals", () => ({ sendApproval: (w: string, a: Record<string, unknown>) => sendApproval(w, a) }));
vi.mock("@/lib/llm", () => ({ hasLLM: () => true, complete: vi.fn(async () => null) }));

import { applyHygieneRun, inHygieneWindow, processHygieneDecisions, revertHygieneRun, runWeeklyHygiene, type HygieneBackup } from "./service";

const old = new Date("2026-08-01T00:00:00Z");
const now = new Date("2026-10-12T02:00:00Z"); // 월 11:00 KST
const lesson = (id: string, o: Partial<Row> = {}): Row => ({ id, workspaceId: "w1", title: `제목 ${id}`, body: `본문 ${id}`, projectId: null, stack: null, userId: null, mode: "default", keywords: [], createdById: "u1", createdAt: old, updatedAt: old, ...o });

const llmAnswer = JSON.stringify({
  merges: [{ keepId: "a", mergeIds: ["b"], newTitle: "합친 제목", newBody: "합친 본문", reason: "같은 규칙" }],
  drops: [{ id: "c", reason: "낡음" }, { id: "req", reason: "필수 삭제 시도" }, { id: "mine", reason: "남의 개인" }],
  ondemand: [{ id: "od", keywords: ["슬랙", "Approval"], reason: "" }],
  scopeFixes: [{ id: "g", to: "project:반장 (P1)", reason: "반장 얘기" }],
  review: [],
  required: [],
});
const runner = vi.fn(async () => llmAnswer);

beforeEach(() => {
  ctr.seq = 0;
  db.lessons = [
    lesson("a", { title: "슬랙 승인 카드 채널 명시" }),
    lesson("b", { title: "슬랙 승인 카드 채널 명시 필수" }),
    lesson("c"),
    lesson("g"),
    lesson("od", { mode: "ondemand" }),
    lesson("req", { mode: "required" }),
    lesson("mine", { userId: "u2" }),
  ];
  db.runs = [];
  db.approvals = [];
  db.projects = [{ id: "P1", workspaceId: "w1", name: "반장", stack: [], archivedAt: null }];
  db.injections = [{ id: "i1", workspaceId: "w1", projectId: null, gistIds: ["req"], titleIds: [], createdAt: new Date("2026-10-10T00:00:00Z") }];
  db.reads = [];
  sendApproval.mockClear();
  runner.mockClear();
});

describe("inHygieneWindow", () => {
  it("Asia/Seoul 월요일 10시 이후만", () => {
    expect(inHygieneWindow(new Date("2026-10-12T01:00:00Z"))).toBe(true); // 월 10:00 KST
    expect(inHygieneWindow(new Date("2026-10-12T00:59:00Z"))).toBe(false); // 월 09:59
    expect(inHygieneWindow(new Date("2026-10-13T01:00:00Z"))).toBe(false); // 화
  });
});

describe("runWeeklyHygiene", () => {
  it("dryRun 은 저장·카드 없이 검증된 제안만 돌려준다(필수·개인 삭제는 걸러짐)", async () => {
    const r = await runWeeklyHygiene("w1", { now, dryRun: true, run: runner });
    expect(r.dryRun).toBe(true);
    if (!r.dryRun) return;
    expect(r.proposal.drops.map((d) => d.id)).toEqual(["c"]);
    expect(r.proposal.merges[0].mergeIds).toEqual(["b"]);
    expect(r.proposal.ondemand).toEqual([{ id: "od", keywords: ["슬랙", "approval"], reason: "" }]);
    expect(r.proposal.scopeFixes).toEqual([{ id: "g", to: "project:P1", reason: "반장 얘기" }]);
    expect(db.runs).toHaveLength(0);
    expect(sendApproval).not.toHaveBeenCalled();
    // 개인 레슨은 LLM 프롬프트에도 들어가지 않는다
    for (const call of runner.mock.calls as unknown as [string][]) expect(call[0]).not.toContain("### mine");
    const first = (runner.mock.calls as unknown as [string, { feature: string; workspaceId: string; system: string }][])[0];
    expect(first[1].feature).toBe("lesson-hygiene");
    expect(first[1].workspaceId).toBe("w1");
  });

  it("주(weekKey)마다 한 번 — 두 번째 호출은 기존 실행을 돌려주고 카드도 한 번만", async () => {
    const r1 = await runWeeklyHygiene("w1", { now, run: runner });
    const r2 = await runWeeklyHygiene("w1", { now: new Date(now.getTime() + 3600_000), run: runner });
    expect(!r1.dryRun && r1.created).toBe(true);
    expect(!r2.dryRun && r2.created).toBe(false);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].status).toBe("proposed");
    expect(db.runs[0].approvalId).toBe("ap1");
    expect(sendApproval).toHaveBeenCalledTimes(1);
    const args = sendApproval.mock.calls[0][1];
    expect(args.highRisk).toBe(true);
    expect(String(args.body)).toContain("/settings#lesson-hygiene");
  });

  it("LESSON_HYGIENE_CHANNEL 이 있으면 그 채널로, 없으면 채널을 넘기지 않는다(기본 채널 폴백)", async () => {
    process.env.LESSON_HYGIENE_CHANNEL = "CTEST";
    await runWeeklyHygiene("w1", { now, run: runner });
    expect(sendApproval.mock.calls[0][1].channel).toBe("CTEST");
    delete process.env.LESSON_HYGIENE_CHANNEL;
    db.runs = [];
    await runWeeklyHygiene("w1", { now, run: runner });
    expect(sendApproval.mock.calls[1][1].channel).toBeUndefined();
  });

  it("정리할 게 없으면 status=empty, 카드 없음", async () => {
    db.lessons = [lesson("req", { mode: "required" })];
    const r = await runWeeklyHygiene("w1", { now, run: runner });
    expect(!r.dryRun && r.run.status).toBe("empty");
    expect(sendApproval).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it("LLM 응답이 깨지면 그 묶음은 검토 항목으로만(적용할 변경 없음)", async () => {
    const r = await runWeeklyHygiene("w1", { now, dryRun: true, run: async () => "모르겠어요" });
    if (!r.dryRun) throw new Error("dry");
    expect(r.proposal.merges).toEqual([]);
    expect(r.proposal.drops).toEqual([]);
    expect(r.proposal.review.length).toBeGreaterThan(0);
    expect(r.proposal.review.some((x) => x.id === "mine")).toBe(false);
  });
});

describe("승인 → 적용 → 되돌리기", () => {
  async function proposed() {
    await runWeeklyHygiene("w1", { now, run: runner });
    db.approvals = [{ id: "ap1", workspaceId: "w1", status: "pending" }];
    return db.runs[0].id;
  }

  it("pending 이면 아무것도 안 하고, rejected 면 rejected", async () => {
    await proposed();
    expect(await processHygieneDecisions(now)).toEqual({ applied: 0, rejected: 0, failed: 0 });
    db.approvals[0].status = "rejected";
    expect((await processHygieneDecisions(now)).rejected).toBe(1);
    expect(db.runs[0].status).toBe("rejected");
    expect(db.lessons.map((l) => l.id)).toContain("c");
  });

  it("approved 면 적용(백업 포함), 되돌리면 원래 id·값으로 복원", async () => {
    const runId = await proposed();
    const before = JSON.parse(JSON.stringify(db.lessons.filter((l) => ["a", "b", "c", "g", "od"].includes(l.id))));
    db.approvals[0].status = "approved";
    const d = await processHygieneDecisions(now);
    expect(d.applied).toBe(1);
    const run = db.runs[0];
    expect(run.status).toBe("applied");
    const ids = db.lessons.map((l) => l.id).sort();
    expect(ids).toEqual(["a", "g", "mine", "od", "req"]);
    expect(db.lessons.find((l) => l.id === "a")?.title).toBe("합친 제목");
    expect(db.lessons.find((l) => l.id === "g")?.projectId).toBe("P1");
    expect(db.lessons.find((l) => l.id === "od")?.keywords).toEqual(["슬랙", "approval"]);
    const backup = run.backup as HygieneBackup;
    expect(backup.lessons.map((l) => l.id).sort()).toEqual(["a", "b", "c", "g", "od"]);

    // 두 번째 처리는 아무것도 안 한다(이미 applied)
    expect((await processHygieneDecisions(now)).applied).toBe(0);

    const r = await revertHygieneRun("w1", runId, now);
    expect(r).toEqual({ restored: 3, recreated: 2 });
    expect(db.runs[0].status).toBe("reverted");
    for (const b of before) {
      const cur = db.lessons.find((l) => l.id === b.id) as Row;
      expect(cur).toBeTruthy();
      expect(cur.title).toBe(b.title);
      expect(cur.body).toBe(b.body);
      expect(cur.projectId).toBe(b.projectId);
      expect(cur.mode).toBe(b.mode);
      expect(cur.keywords).toEqual(b.keywords);
    }
    await expect(revertHygieneRun("w1", runId, now)).rejects.toThrow(/적용된 정리만/);
  });

  it("제안 뒤 사람이 고친 레슨은 건너뛴다", async () => {
    const runId = await proposed();
    const c = db.lessons.find((l) => l.id === "c") as Row;
    c.updatedAt = new Date(Date.now() + 60_000);
    const r = await applyHygieneRun(runId, now);
    expect(r.status).toBe("applied");
    expect(r.skipped).toContain("c");
    expect(db.lessons.some((l) => l.id === "c")).toBe(true);
  });

  it("다른 워크스페이스의 실행은 되돌릴 수 없다(404)", async () => {
    const runId = await proposed();
    await expect(revertHygieneRun("w2", runId, now)).rejects.toThrow(/찾을 수 없습니다/);
  });

  it("적용 중 예외면 failed 로 표시하고 레슨은 그대로", async () => {
    const runId = await proposed();
    fake.$transaction.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const r = await applyHygieneRun(runId, now);
    expect(r.status).toBe("failed");
    expect(db.runs[0].status).toBe("failed");
    expect(String(db.runs[0].summary)).toContain("boom");
  });
});

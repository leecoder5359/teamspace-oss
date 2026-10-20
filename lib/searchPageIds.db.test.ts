import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * 감사 P-3 — 검색 후보 id 를 트라이그램 GIN 으로 모으는지 실제 Postgres 로 확인한다. 전용 테스트 DB(마이그레이션 적용됨)가
 * 주어질 때만 돈다:
 *   SEARCH_TRGM_TEST_DATABASE_URL=postgresql://…/teamspace_<worktree>_test pnpm vitest run lib/searchPageIds.db.test.ts
 * (운영/개발 DB 를 가리키지 말 것 — 워크스페이스·문서를 만들고 지운다.)
 */
const DB = process.env.SEARCH_TRGM_TEST_DATABASE_URL;

describe.skipIf(!DB)("검색 후보 id(실DB)", () => {
  let prisma: typeof import("@/lib/prisma").prisma;
  let trgm: typeof import("./searchPageIds");
  let wsId: string;
  let userId: string;
  const ids: Record<string, string> = {};
  const stamp = Date.now();

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    ({ prisma } = await import("@/lib/prisma"));
    trgm = await import("./searchPageIds");
    const ws = await prisma.workspace.create({ data: { name: `trgm-test-${stamp}` } });
    wsId = ws.id;
    const user = await prisma.user.create({ data: { email: `trgm-${stamp}@trgm.test`, name: "P-3" } });
    userId = user.id;
    const mk = async (key: string, title: string, markdown: string) => {
      ids[key] = (await prisma.page.create({ data: { workspaceId: wsId, title, markdown, createdById: user.id } })).id;
    };
    await mk("title", `배포 파이프라인 ${stamp}`, "본문 없음");
    await mk("body", "운영 노트", `여기 본문 중간에 Deploy Pipeline ${stamp} 이 나온다`);
    await mk("none", "무관한 문서", "아무 관계 없는 내용");
    // 짧은 질의(2글자) 본문 상한 확인용: 가장 오래된 문서에만 "쀍뷁" 이 본문에 있다
    await mk("oldBody", "옛 문서", "본문에 쀍뷁 이 있다");
    await prisma.page.update({ where: { id: ids.oldBody }, data: { updatedAt: new Date("2000-01-01T00:00:00Z") } });
    await mk("shortTitle", "쀍뷁 제목", "본문 없음");
    await mk("note", "[태스크 설명] 무엇", "본문에 쀍뷁");
    await prisma.page.update({ where: { id: ids.note }, data: { docType: "task_note" } });
  });

  afterAll(async () => {
    await prisma.page.deleteMany({ where: { workspaceId: wsId } });
    await prisma.workspace.delete({ where: { id: wsId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("제목·본문 어느 쪽 일치든 id 를 돌려준다(대소문자 무시)", async () => {
    const got = await trgm.trigramPageIds(wsId, [`파이프라인 ${stamp}`]);
    expect(got).toContain(ids.title);
    expect(got).not.toContain(ids.body);
    const en = await trgm.trigramPageIds(wsId, [`deploy pipeline ${stamp}`, `없는변형 ${stamp}`]);
    expect(en).toEqual([ids.body]);
  });

  it("이 워크스페이스의 삭제되지 않은 문서만", async () => {
    expect(await trgm.trigramPageIds("no-such-ws", [`파이프라인 ${stamp}`])).toEqual([]);
    // 휴지통 문서(가장 오래된 것으로 둬 아래 짧은 질의 창 순서를 흔들지 않는다)
    await prisma.page.create({
      data: { workspaceId: wsId, title: `휴지통 ${stamp}`, markdown: "", createdById: userId, deletedAt: new Date(), updatedAt: new Date("1999-01-01T00:00:00Z") },
    });
    expect(await trgm.trigramPageIds(wsId, [`휴지통 ${stamp}`])).toEqual([]);
  });

  it("계획 강제는 그 트랜잭션 안에서만 — 끝나면 enable_seqscan 이 원래대로", async () => {
    await trgm.trigramPageIds(wsId, ["무관한"]);
    const [row] = await prisma.$queryRaw<{ enable_seqscan: string }[]>`SHOW enable_seqscan`;
    expect(row.enable_seqscan).toBe("on");
  });

  it("같은 설정에서 1단계 쿼리(워크스페이스 조건 포함)는 트라이그램 GIN 두 개를 BitmapOr 로 탄다", async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(trgm.FORCE_TRGM_SQL);
      return tx.$queryRaw<{ "QUERY PLAN": string }[]>`EXPLAIN ${trgm.trigramIdsSql(wsId, ["존재하지않는검색어입니다"])}`;
    });
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toContain("Page_title_trgm_idx");
    expect(text).toContain("Page_markdown_trgm_idx");
    expect(text).not.toContain("Seq Scan");
  });

  describe("shortQueryPageIds(3글자 미만)", () => {
    const opts = { includeArchived: false, includeTaskNotes: false };
    it("제목 일치는 전부, 본문 일치는 최근 문서 상한 안에서만", async () => {
      const wide = await trgm.shortQueryPageIds(wsId, ["쀍뷁"], opts);
      expect(wide.sort()).toEqual([ids.oldBody, ids.shortTitle].sort());
      const capped = await trgm.shortQueryPageIds(wsId, ["쀍뷁"], { ...opts, bodyScanDocs: 2 });
      expect(capped).toContain(ids.shortTitle); // 제목은 상한과 무관
      expect(capped).not.toContain(ids.oldBody); // 가장 오래된 문서의 본문은 상한 밖
    });
    it("다른 워크스페이스는 보지 않는다", async () => {
      expect(await trgm.shortQueryPageIds("no-such-ws", ["쀍뷁"], opts)).toEqual([]);
    });
    it("태스크 설명은 본문 상한 자리를 차지하지 않는다(includeTaskNotes 면 포함)", async () => {
      // 가장 최근은 note(태스크 설명). 빼고 세면 상한 1 자리는 shortTitle 이고 note 의 본문 일치는 빠진다
      const capped = await trgm.shortQueryPageIds(wsId, ["쀍뷁"], { ...opts, bodyScanDocs: 1 });
      expect(capped).toEqual([ids.shortTitle]);
      const withNotes = await trgm.shortQueryPageIds(wsId, ["쀍뷁"], { includeArchived: false, includeTaskNotes: true, bodyScanDocs: 1 });
      expect(withNotes.sort()).toEqual([ids.shortTitle, ids.note].sort());
    });
  });
});

import { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";

/*
 * 검색 1단계 — 제목·본문 일치 페이지 **id 만** 모은다. 2단계(app/api/search)가 이 id 로 워크스페이스·삭제·보관·
 * 태스크 설명 조건을 걸어 본문을 읽는다. 둘을 나눈 이유는 감사 P-3 의 EXPLAIN (ANALYZE) 실측(문서 552건·markdown 5.5MB):
 *
 * - Prisma 가 내는 `title ILIKE … OR markdown ILIKE …` 는 트라이그램 GIN(마이그레이션 20260808140000)을 **안 탔다**.
 *   일치 0건 13자 질의도 Seq Scan 575~640ms. OR 때문이 아니다(본문 한 칸만 걸어도 같다) — 플래너는 TOAST 로 빠진
 *   본문을 풀고 lower 하는 비용을 세지 않아 표가 작아 보이면 순차 스캔이 늘 싸 보인다. 같은 질의에 GIN 을 강제하면 1~3ms.
 * - 다른 조건(workspaceId 등)을 같은 쿼리에 두면 그 btree 비트맵을 골라 결국 본문을 다 훑는다.
 *   (식으로 감싸 btree 를 못 쓰게 하면 GIN 그대로 — trigramIdsSql.) 그리고 `id IN (…) AND markdown ILIKE …` 도
 *   ILIKE 를 먼저 평가해 전 행을 푼다 — 그래서 "id 만 먼저" 다.
 */

/** 이 트랜잭션에서만 seqscan·indexscan·indexonlyscan 을 끈다 → 남는 길은 인덱스 조건이 있어야 하는 비트맵 스캔뿐이라 트라이그램 GIN 만 남는다. */
export const FORCE_TRGM_SQL =
  "SELECT set_config('enable_seqscan', 'off', true), set_config('enable_indexscan', 'off', true), set_config('enable_indexonlyscan', 'off', true)";

/** 1단계 id 상한 — 2단계 `id IN (…)` 바인딩 수를 묶는다(PG 파라미터 한도 32767). 넘치면 최근 수정 순으로 자른다. */
export const MATCH_ID_CAP = 5000;

/** 3글자 미만 질의가 본문을 훑는 최근 문서 수. 2글자 본문 ILIKE 는 GIN 이 못 도와 전수 스캔(~470ms)이 되므로 최근 것만 본다(이 데이터에서 100건 ≈ 95ms). */
export const SHORT_BODY_SCAN_DOCS = 100;

/** variants 를 col ILIKE '%v%' OR … 로. 패턴은 Prisma `contains` 와 같은 꼴(와일드카드 이스케이프 없음). */
const ilikeAny = (col: "title" | "markdown", variants: string[]) =>
  Prisma.join(variants.map((v) => Prisma.sql`${Prisma.raw(`"${col}"`)} ILIKE ('%' || ${v} || '%')`), " OR ");

/**
 * 3글자 이상 1단계 SQL. 워크스페이스는 `("workspaceId" || '') = $ws` 로 건다 — 식이라 workspaceId btree 가 못 붙고
 * GIN BitmapOr 뒤 Filter 로만 돈다(그냥 `"workspaceId" = $ws` 면 플래너가 btree 비트맵을 골라 본문을 다 훑는다).
 * deletedAt IS NULL 도 인덱스 조건이 아니라 Filter. 상한 전에 최근 수정 순으로 정렬해 잘리는 쪽을 정해 둔다.
 */
export function trigramIdsSql(workspaceId: string, variants: string[]): Prisma.Sql {
  return Prisma.sql`SELECT id FROM "Page"
    WHERE ("workspaceId" || '') = ${workspaceId} AND "deletedAt" IS NULL AND (${ilikeAny("title", variants)} OR ${ilikeAny("markdown", variants)})
    ORDER BY "updatedAt" DESC LIMIT ${MATCH_ID_CAP}`;
}

/**
 * 제목·본문에 variants 중 하나라도 들어 있는 이 워크스페이스의 (삭제 안 된) 페이지 id — 트라이그램 GIN 으로.
 * 3글자 미만 질의에는 쓰지 말 것 — 트라이그램이 안 나와 GIN 이 전체를 훑는다(shortQueryPageIds 를 쓴다).
 */
export async function trigramPageIds(workspaceId: string, variants: string[]): Promise<string[]> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRawUnsafe(FORCE_TRGM_SQL);
    const rows = await tx.$queryRaw<{ id: string }[]>(trigramIdsSql(workspaceId, variants));
    return rows.map((r) => r.id);
  });
}

/**
 * 3글자 미만 질의: 제목 일치(제목은 짧아 전수여도 수 ms)는 전부 + 본문 일치는 최근 수정 bodyScanDocs 개 안에서만.
 * 이 워크스페이스의 삭제 안 된 문서만 본다(본문 창 100개도 그 안에서 센다).
 * 최근 문서 하위쿼리는 LIMIT 때문에 바깥으로 풀리지 않아 본문 ILIKE 가 그 안에서만 돈다.
 */
export async function shortQueryPageIds(
  workspaceId: string,
  variants: string[],
  opts: { includeArchived: boolean; includeTaskNotes: boolean; bodyScanDocs?: number },
): Promise<string[]> {
  const archived = opts.includeArchived ? Prisma.empty : Prisma.sql`AND "archivedAt" IS NULL`;
  const taskNotes = opts.includeTaskNotes ? Prisma.empty : Prisma.sql`AND ("docType" IS NULL OR "docType" <> 'task_note')`;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    (SELECT id FROM "Page" WHERE "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL AND (${ilikeAny("title", variants)}) ORDER BY "updatedAt" DESC LIMIT ${MATCH_ID_CAP})
    UNION
    SELECT id FROM (
      SELECT id, markdown FROM "Page"
      WHERE "workspaceId" = ${workspaceId} AND "deletedAt" IS NULL ${archived} ${taskNotes}
      ORDER BY "updatedAt" DESC LIMIT ${opts.bodyScanDocs ?? SHORT_BODY_SCAN_DOCS}
    ) recent WHERE ${ilikeAny("markdown", variants)}`;
  return rows.map((r) => r.id);
}

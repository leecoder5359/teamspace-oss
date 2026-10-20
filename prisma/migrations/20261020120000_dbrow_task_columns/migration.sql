-- 열린 태스크 조회용 비정규화(감사 P-14): props JSON 에서 상태 옵션 id·담당자 이름을 칸으로 뽑는다.
-- 추가(additive)만. taskColsKey 가 지금 속성과 다른(또는 null) 행은 읽기 쪽(lib/taskRows)이 props 로 거른다.
-- 키가 맞는데 칸이 낡은 행(새 코드를 거치지 않은 props 쓰기 — 롤백 구간·수동 SQL 등)은 이 보장 밖이라,
-- 아래 백필은 lib/taskColumnsSql.ts 와 같은 문자열이고 scripts/rederive-task-columns.ts 가 배포마다 다시 돌린다(멱등).

-- AlterTable
ALTER TABLE "DbRow" ADD COLUMN     "statusOptionId" TEXT,
ADD COLUMN     "assigneeText" TEXT,
ADD COLUMN     "taskColsKey" TEXT;

-- CreateIndex
CREATE INDEX "DbRow_databasePageId_assigneeText_idx" ON "DbRow"("databasePageId", "assigneeText");

-- Backfill — lib/taskColumnsSql.ts REDERIVE_TASK_COLUMNS_SQL 그대로(lib/taskColumnsSql.test 가 일치를 강제한다).
WITH status_prop AS (
  SELECT DISTINCT ON ("databasePageId") "databasePageId", "id"
  FROM "DbProperty"
  WHERE "type" = 'select'
  ORDER BY "databasePageId", ("name" ~* '(status|상태)') DESC, "position" ASC, "id" ASC
), assignee_prop AS (
  SELECT DISTINCT ON ("databasePageId") "databasePageId", "id"
  FROM "DbProperty"
  WHERE "type" IN ('text', 'person') AND "name" ~* '(담당|assignee|owner)'
  ORDER BY "databasePageId", "position" ASC, "id" ASC
), derived AS (
  SELECT r."id",
         CASE WHEN jsonb_typeof(r."props" -> sp."id") = 'string' THEN r."props" ->> sp."id" END AS "statusOptionId",
         CASE WHEN jsonb_typeof(r."props" -> ap."id") = 'string'
              THEN NULLIF(regexp_replace(r."props" ->> ap."id", '^[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\t\n\u000b\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$', '', 'g'), '') END AS "assigneeText",
         COALESCE(sp."id", '') || '|' || COALESCE(ap."id", '') AS "taskColsKey"
  FROM "DbRow" r
  LEFT JOIN status_prop sp ON sp."databasePageId" = r."databasePageId"
  LEFT JOIN assignee_prop ap ON ap."databasePageId" = r."databasePageId"
)
UPDATE "DbRow" AS t
SET "statusOptionId" = d."statusOptionId",
    "assigneeText"   = d."assigneeText",
    "taskColsKey"    = d."taskColsKey"
FROM derived d
WHERE t."id" = d."id"
  AND (t."statusOptionId" IS DISTINCT FROM d."statusOptionId"
    OR t."assigneeText" IS DISTINCT FROM d."assigneeText"
    OR t."taskColsKey" IS DISTINCT FROM d."taskColsKey");

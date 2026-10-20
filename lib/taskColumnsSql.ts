/* =====================================================================
   DbRow 비정규화 칸 재계산 SQL — 단일 원본(감사 P-14, 리뷰 I-1·I-2).
   마이그레이션 20261020120000_dbrow_task_columns 가 이 문자열을 그대로 담고(lib/taskColumnsSql.test 가 강제),
   scripts/rederive-task-columns.ts 가 배포 때마다 다시 돌린다. 값이 이미 같은 행은 쓰지 않아 멱등이다.
   lib/taskProps 휴리스틱 + lib/taskColumns.deriveTaskColumns 를 SQL 로 옮긴 것:
     상태 = 이름에 status|상태 가 든 첫 select(position, id 순), 없으면 첫 select
     담당자 = 이름에 담당|assignee|owner 가 든 첫 text/person
     값이 문자열일 때만 칸에 넣고, 담당자는 JS trim 과 같은 문자 집합으로 앞뒤를 다듬어 빈 값이면 null.
   ===================================================================== */

/** ECMAScript WhiteSpace + LineTerminator — String.prototype.trim 이 지우는 문자 전부.
 *  Postgres ARE 와 JS RegExp 가 둘 다 같은 뜻으로 읽는 표기(\uXXXX·\t 등)로 쓴다. `\s` 는 로케일에 따라 NBSP·BOM 을 놓친다. */
// 일반 문자열 + 이중 백슬래시로 적는다 — 소스·SQL 파일이 ASCII 로만 남아 보이지 않는 공백 문자가 섞이지 않는다.
export const JS_TRIM_CLASS = "[\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";

/** 재계산 SQL. board 를 주면 그 보드의 지정 행만($1 = databasePageId, $2 = 행 id 배열) — 속성 변경 뒤(lib/taskRows.rederiveBoardTaskColumns).
 *  board 없이 만든 문자열이 마이그레이션에 그대로 들어 있다(lib/taskColumnsSql.test) — 조각을 바꾸면 그 테스트가 깨진다. */
function rederiveSql(board: boolean): string {
  const prop = board ? ` AND "databasePageId" = $1` : "";
  const rows = board ? `\n  WHERE r."databasePageId" = $1 AND r."id" = ANY($2::text[])` : "";
  return `WITH status_prop AS (
  SELECT DISTINCT ON ("databasePageId") "databasePageId", "id"
  FROM "DbProperty"
  WHERE "type" = 'select'${prop}
  ORDER BY "databasePageId", ("name" ~* '(status|상태)') DESC, "position" ASC, "id" ASC
), assignee_prop AS (
  SELECT DISTINCT ON ("databasePageId") "databasePageId", "id"
  FROM "DbProperty"
  WHERE "type" IN ('text', 'person') AND "name" ~* '(담당|assignee|owner)'${prop}
  ORDER BY "databasePageId", "position" ASC, "id" ASC
), derived AS (
  SELECT r."id",
         CASE WHEN jsonb_typeof(r."props" -> sp."id") = 'string' THEN r."props" ->> sp."id" END AS "statusOptionId",
         CASE WHEN jsonb_typeof(r."props" -> ap."id") = 'string'
              THEN NULLIF(regexp_replace(r."props" ->> ap."id", '^${JS_TRIM_CLASS}+|${JS_TRIM_CLASS}+$', '', 'g'), '') END AS "assigneeText",
         COALESCE(sp."id", '') || '|' || COALESCE(ap."id", '') AS "taskColsKey"
  FROM "DbRow" r
  LEFT JOIN status_prop sp ON sp."databasePageId" = r."databasePageId"
  LEFT JOIN assignee_prop ap ON ap."databasePageId" = r."databasePageId"${rows}
)
UPDATE "DbRow" AS t
SET "statusOptionId" = d."statusOptionId",
    "assigneeText"   = d."assigneeText",
    "taskColsKey"    = d."taskColsKey"
FROM derived d
WHERE t."id" = d."id"
  AND (t."statusOptionId" IS DISTINCT FROM d."statusOptionId"
    OR t."assigneeText" IS DISTINCT FROM d."assigneeText"
    OR t."taskColsKey" IS DISTINCT FROM d."taskColsKey")`;
}

export const REDERIVE_TASK_COLUMNS_SQL = rederiveSql(false);
/** 한 보드의 지정 행만 — $1 = databasePageId, $2 = 행 id 배열(text[]). */
export const REDERIVE_BOARD_TASK_COLUMNS_SQL = rederiveSql(true);

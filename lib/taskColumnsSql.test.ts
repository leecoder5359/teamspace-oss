import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JS_TRIM_CLASS, REDERIVE_BOARD_TASK_COLUMNS_SQL, REDERIVE_TASK_COLUMNS_SQL } from "./taskColumnsSql";
import { deriveTaskColumns } from "./taskColumns";

/* SQL 백필의 담당자 다듬기는 JS String.prototype.trim(= deriveTaskColumns)과 정확히 같아야 한다 —
   다르면 키는 맞는데 assigneeText 가 틀린 행이 빠른 경로에서 사라진다(리뷰 I-1: NBSP·BOM). */
describe("JS_TRIM_CLASS", () => {
  const re = new RegExp(`^${JS_TRIM_CLASS}+|${JS_TRIM_CLASS}+$`, "g");

  it("BMP 의 모든 문자에서 JS trim 과 같은 판정을 낸다", () => {
    const diff: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue; // 외톨이 서로게이트
      const ch = String.fromCharCode(c);
      const s = `${ch}a${ch}`;
      if (s.replace(re, "") !== s.trim()) diff.push(c.toString(16));
    }
    expect(diff).toEqual([]);
  });

  it("ASCII 만으로 적는다 — SQL 파일에 보이지 않는 문자가 섞이지 않게", () => {
    expect(/^[\x20-\x7e]+$/.test(JS_TRIM_CLASS)).toBe(true);
  });

  it("NBSP·BOM·전각 공백을 다듬는다 — deriveTaskColumns 와 같은 결과", () => {
    const props = [{ id: "a", name: "담당자", type: "text" }];
    for (const v of ["\u00a0이준", "\ufeff이준\ufeff", "\u3000이준\u2028"]) {
      expect(v.replace(re, "")).toBe(deriveTaskColumns(props, { a: v }).assigneeText);
    }
  });
});

describe("REDERIVE_TASK_COLUMNS_SQL", () => {
  it("담당자 다듬기에 JS_TRIM_CLASS 를 쓴다", () => {
    expect(REDERIVE_TASK_COLUMNS_SQL).toContain(`'^${JS_TRIM_CLASS}+|${JS_TRIM_CLASS}+$'`);
  });

  it("마이그레이션 파일이 같은 SQL 을 그대로 담는다(단일 원본 — 재실행 스크립트와 갈라지지 않게)", () => {
    const migration = readFileSync(new URL("../prisma/migrations/20261020120000_dbrow_task_columns/migration.sql", import.meta.url), "utf8");
    expect(migration).toContain(REDERIVE_TASK_COLUMNS_SQL);
  });

  it("값이 이미 같은 행은 다시 쓰지 않는다(재실행 가능·멱등)", () => {
    expect(REDERIVE_TASK_COLUMNS_SQL).toMatch(/IS DISTINCT FROM d\."statusOptionId"/);
    expect(REDERIVE_TASK_COLUMNS_SQL).toMatch(/IS DISTINCT FROM d\."assigneeText"/);
    expect(REDERIVE_TASK_COLUMNS_SQL).toMatch(/IS DISTINCT FROM d\."taskColsKey"/);
  });
});

describe("REDERIVE_BOARD_TASK_COLUMNS_SQL", () => {
  it("속성·행 둘 다 한 보드($1)의 지정 행($2)으로 좁힌다 — 다른 보드 속성을 읽거나 다른 행을 쓰지 않게", () => {
    expect(REDERIVE_BOARD_TASK_COLUMNS_SQL.match(/AND "databasePageId" = \$1/g)).toHaveLength(2);
    expect(REDERIVE_BOARD_TASK_COLUMNS_SQL).toContain(`WHERE r."databasePageId" = $1 AND r."id" = ANY($2::text[])`);
  });

  it("범위만 다르고 계산은 전체 재계산과 같다", () => {
    const strip = (q: string) => q.replace(/ AND "databasePageId" = \$1/g, "").replace(/\n  WHERE r\."databasePageId" = \$1 AND r\."id" = ANY\(\$2::text\[\]\)/, "");
    expect(strip(REDERIVE_BOARD_TASK_COLUMNS_SQL)).toBe(REDERIVE_TASK_COLUMNS_SQL);
  });
});

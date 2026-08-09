/* =====================================================================
   보드(CSV) 가져오기 — 순수 함수. IO 도 DB 도 모른다. (격차 E2 후속)

   E1 내보내기는 보드를 `boards/<보드>.csv` 로 꺼내는데, E2 가져오기는 그걸
   "보드 CSV 는 아직 가져오지 않습니다" 라며 버렸다. 즉 **자기 내보내기를 자기가
   다시 못 읽는** 상태였다 — 왕복이 안 되는 반출입은 백업이라고 부를 수 없다.
   노션 데이터베이스 CSV 도 같은 모양이라 한 경로로 같이 받는다.

   CSV 는 타입이 없다. 그래서 열마다 값을 보고 타입을 **추론**하는데, 규칙은
   전부 "틀리면 값이 사라지는가" 로 정했다:
     · 확신이 없으면 text 로 둔다 — text 는 원문을 그대로 보관하니 잃는 게 없다.
     · 날짜는 순서가 확실한 표기만 읽는다(08/09/2026 은 월·일을 알 수 없어 거절).
     · 다중값처럼 보이는 열(콤마 든 값)은 multiselect 가 아직 만들 수 없으니 text.
   추론이 소심한 대신, 가져온 뒤 열 타입을 바꾸는 건 화면에서 한 번이면 된다.
   ===================================================================== */

/** 만들 수 있는 열 타입. multiselect·person·relation 은 CSV 만 보고 만들지 않는다. */
export type CsvPropType = "text" | "number" | "date" | "select" | "checkbox";

export type CsvCell = string | number | boolean | null;

export type PlannedBoardColumn = {
  name: string;
  type: CsvPropType;
  /** select 일 때만 채운다 — 등장 순서대로 모은 후보값(이름) */
  options: string[];
};

export type PlannedBoardRow = {
  /** 열 순서에 맞춘 값. 길이는 항상 columns.length. */
  cells: CsvCell[];
  /**
   * 이 행의 본문이 될 문서의 zip 경로. 노션은 데이터베이스를 CSV 한 개 +
   * 행마다 md 한 개로 내보내므로, 제목이 같은 문서를 찾아 행에 붙인다.
   * (planImport 가 채운다 — 여기서는 자리만 둔다.)
   */
  contentDocPath?: string | null;
};

export type PlannedBoard = {
  /** zip 안의 원래 경로 — 미리보기에서 무엇이 어디로 가는지 보여주기 위해 */
  path: string;
  title: string;
  projectName: string | null;
  /** 이 보드가 들어갈 폴더 경로 키. 최상위면 null */
  folderPath?: string | null;
  columns: PlannedBoardColumn[];
  rows: PlannedBoardRow[];
  warnings: string[];
};

/* ── CSV 파싱 ───────────────────────────────────────────────────────── */

/**
 * RFC4180 CSV → 셀 표. 따옴표 안의 콤마·줄바꿈·`""` 를 지킨다.
 *
 * 따옴표 없는 셀은 앞뒤 공백을 다듬고, 따옴표 안은 **그대로 둔다** — 공백이
 * 의미 있는 값은 따옴표로 감싸는 게 CSV 의 규약이다.
 * 완전히 빈 줄은 행으로 세지 않는다(파일 끝 개행이 유령 행을 만들지 않도록).
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false; // 이 셀이 따옴표로 감싸였나(공백 다듬기 여부)
  let inQuotes = false;
  let sawCell = false;

  const endCell = () => {
    row.push(quoted ? cell : cell.trim());
    cell = "";
    quoted = false;
    sawCell = true;
  };
  const endRow = () => {
    endCell();
    // 셀이 하나뿐이고 그마저 비었으면 빈 줄이다
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
    sawCell = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      quoted = true;
      continue;
    }
    if (ch === ",") {
      endCell();
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\n") {
      endRow();
      continue;
    }
    cell += ch;
  }
  // 파일이 개행 없이 끝난 경우
  if (cell !== "" || quoted || sawCell || row.length > 0) endRow();
  return rows;
}

/* ── 값 읽기 ────────────────────────────────────────────────────────── */

const TRUE_WORDS = new Set(["yes", "y", "true", "예", "체크", "o", "✓", "☑"]);
const FALSE_WORDS = new Set(["no", "n", "false", "아니오", "아니요", "미체크", "x", "✗", "☐"]);

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const NUMBER_RE = /^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/;

/** 실재하는 날짜인지 확인하고 `YYYY-MM-DD` 로 만든다. 2026-02-31 같은 건 거절. */
function ymd(y: number, m: number, d: number): string | null {
  if (!(y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() + 1 !== m || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * 날짜 한 개를 `YYYY-MM-DD` 로. 읽을 수 있는 표기가 아니면 null.
 *
 * 받는 것: ISO(`2026-08-09`, 시각 포함) · `2026/8/9` · 노션 영문(`August 9, 2026`,
 * 뒤에 시각이 붙어도 됨) · 한국식(`2026년 8월 9일`).
 * **거절**하는 것: `08/09/2026`(월·일 순서를 알 수 없다) · 날짜 범위(`A → B`).
 * 거절된 열은 통째로 text 가 되어 원문이 그대로 남는다 — 잘못 읽는 것보다 낫다.
 */
export function parseDateCell(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][0-9:.+\-Z]*)?$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);

  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[T ][0-9:.+\-Z]*)?$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);

  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap]\.?[Mm]\.?)?)?$/.exec(s);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    return mon ? ymd(+m[3], mon, +m[2]) : null;
  }

  m = /^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);

  return null;
}

function parseBoolCell(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  return null;
}

function parseNumberCell(raw: string): number | null {
  const s = raw.trim();
  if (!NUMBER_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** select 후보로 볼 값의 상한 — 이보다 종류가 많으면 라벨이 아니라 자유 입력이다. */
const MAX_OPTIONS = 12;
/** select 옵션 이름 길이 상한 — 문장은 라벨이 아니다. */
const MAX_OPTION_LEN = 40;

/**
 * 열 값들만 보고 타입을 고른다. 빈 값은 판단에서 뺀다(빈칸은 어느 타입에나 있다).
 *
 * 순서: checkbox → number → date → select → text.
 * number 를 checkbox 보다 뒤에 두지 않는 이유는 `1/0` 이다 — 진행률 0 을
 * "체크 안 됨" 으로 바꿔 버리면 숫자가 사라진다. 그래서 참·거짓 낱말은
 * yes/no·true/false 같은 **말**만 인정한다.
 */
export function inferCsvType(values: string[]): CsvPropType {
  const vals = values.map((v) => v.trim()).filter((v) => v !== "");
  if (vals.length === 0) return "text";

  if (vals.every((v) => parseBoolCell(v) !== null)) return "checkbox";
  if (vals.every((v) => parseNumberCell(v) !== null)) return "number";
  if (vals.every((v) => parseDateCell(v) !== null)) return "date";

  // select: 짧은 라벨이 되풀이되는 열. 콤마가 든 값은 노션 다중 선택이라
  // 한 덩어리 옵션으로 만들면 뜻이 망가진다 — 그런 열은 글자로 남긴다.
  const distinct = new Set(vals);
  const selectable =
    vals.length >= 2 &&
    distinct.size <= MAX_OPTIONS &&
    distinct.size < vals.length &&
    vals.every((v) => v.length <= MAX_OPTION_LEN && !v.includes(",") && !v.includes("\n"));
  return selectable ? "select" : "text";
}

/** 다중 선택으로 보이는 열(콤마가 든 짧은 되풀이 값) — 경고 문구를 위해 따로 본다. */
function looksMultiSelect(values: string[]): boolean {
  const vals = values.map((v) => v.trim()).filter(Boolean);
  if (vals.length < 2 || !vals.some((v) => v.includes(","))) return false;
  const parts = new Set(vals.flatMap((v) => v.split(",").map((x) => x.trim())).filter(Boolean));
  return parts.size <= MAX_OPTIONS && [...parts].every((p) => p.length <= MAX_OPTION_LEN);
}

function convert(type: CsvPropType, raw: string): CsvCell {
  const s = raw.trim();
  switch (type) {
    case "checkbox":
      return parseBoolCell(s) ?? false;
    case "number":
      return s === "" ? null : parseNumberCell(s);
    case "date":
      return s === "" ? null : parseDateCell(s);
    default:
      return s === "" ? null : s;
  }
}

/** 같은 이름의 열이 겹치면 " (2)" 를 붙인다(문서 제목 규칙과 같게). */
function uniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  for (let n = 2; ; n++) {
    const cand = `${name} (${n})`;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
}

/** 한 CSV 가 만들 수 있는 행 수 상한(기본) — 사고로 올린 거대 CSV 를 막는다. */
export const DEFAULT_MAX_ROWS = 2000;

/** 내보내기 색인(workspace.json)이 알려준 원래 열. 있으면 추론보다 이걸 믿는다. */
export type KnownColumn = { name: string; type: string; options?: string[] };

export type PlanBoardInput = {
  path: string;
  text: string;
  title: string;
  projectName: string | null;
  folderPath?: string | null;
  maxRows?: number;
  /**
   * 우리 export 왕복용. CSV 는 타입을 잃어버리는데 `workspace.json` 은 원래
   * 열 타입·옵션을 알고 있다 — 행이 한 개라 추론이 못 맞히는 select 도 색인이
   * 있으면 그대로 복원된다.
   */
  known?: KnownColumn[];
};

/** 만들 수 없는 타입은 글자로 낮춘다. 값(원문)은 그대로 남으니 잃는 게 없다. */
function creatableType(type: string): { type: CsvPropType; demoted: boolean } {
  switch (type) {
    case "number":
    case "date":
    case "select":
    case "checkbox":
    case "text":
      return { type, demoted: false };
    default:
      // multiselect·person·relation — 값 하나에 여러 id 가 들어가거나 다른 보드의
      // 행 id 라, CSV 의 사람이 읽는 이름만으로는 되살릴 수 없다.
      return { type: "text", demoted: true };
  }
}

/**
 * CSV 한 개 → 보드 한 개 계획. 만들 게 없으면 null.
 *
 * 첫 열은 값이 되풀이되더라도 **항상 text** 다 — 표의 첫 열은 제목이고,
 * 제목이 select 가 되면 새 행을 쓸 때마다 옵션이 늘어난다(우리 export 의 "이름",
 * 노션의 "Name" 이 정확히 그 자리다).
 */
export function planBoardCsv(input: PlanBoardInput): PlannedBoard | null {
  const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
  const warnings: string[] = [];
  const table = parseCsv(input.text);
  if (table.length === 0) return null;

  // 헤더 — 뒤쪽의 빈 열은 버린다(엑셀·노션이 남기는 꼬리 콤마).
  const rawHeader = [...table[0]];
  while (rawHeader.length > 0 && rawHeader[rawHeader.length - 1].trim() === "") rawHeader.pop();
  if (rawHeader.length === 0) return null;

  const body = table.slice(1);
  const width = rawHeader.length;

  // 열 값 모으기 — 상한을 넘긴 행은 타입 추론에서도 뺀다(만들지 않을 값이니).
  const overWide = body.some((r) => r.length > width);
  const kept: string[][] = [];
  for (const r of body) {
    const cells = Array.from({ length: width }, (_, i) => r[i] ?? "");
    if (cells.every((c) => c.trim() === "")) continue; // 전부 빈 행
    if (kept.length >= maxRows) break;
    kept.push(cells);
  }
  const truncated = body.filter((r) => r.some((c) => c.trim() !== "")).length - kept.length;

  const knownByName = new Map((input.known ?? []).map((k) => [k.name.trim(), k]));
  const usedNames = new Set<string>();
  const columns: PlannedBoardColumn[] = rawHeader.map((h, i) => {
    const values = kept.map((r) => r[i]);
    const name = uniqueName(usedNames, h.trim() || `열 ${i + 1}`);
    const known = knownByName.get(h.trim());

    let type: CsvPropType;
    if (known) {
      const { type: t, demoted } = creatableType(known.type);
      // 색인이 date·number·checkbox 라고 해도 값이 그렇지 않으면 글자로 물러난다.
      // 색인을 맹신하면 읽을 수 없는 값이 조용히 null 이 된다.
      const fits =
        t === "select" || t === "text" || values.every((v) => v.trim() === "" || convert(t, v) !== null);
      type = fits ? t : "text";
      if (demoted) {
        warnings.push(`'${name}' 열은 원래 ${known.type} 이지만 CSV 로는 되살릴 수 없어 글자 열로 만듭니다.`);
      } else if (!fits) {
        warnings.push(`'${name}' 열은 원래 ${known.type} 인데 값이 그 꼴이 아니라 글자 열로 만듭니다.`);
      }
    } else {
      type = i === 0 ? "text" : inferCsvType(values);
    }

    // 첫 열은 규칙상 text 다(제목 열) — 다중 선택으로 의심했다는 경고를 붙이면 거짓말이 된다.
    if (i > 0 && type === "text" && !known && looksMultiSelect(values)) {
      warnings.push(`'${name}' 열은 값이 여러 개인 다중 선택으로 보여 글자 열로 만듭니다(multiselect 는 아직 만들 수 없습니다).`);
    }
    // 옵션: 색인이 알려준 원래 옵션을 먼저 두고, CSV 에만 있는 값을 뒤에 잇는다.
    const seen = kept.length ? [...new Set(values.map((v) => v.trim()).filter(Boolean))] : [];
    const options =
      type === "select" ? [...new Set([...(known?.options ?? []), ...seen])].slice(0, MAX_OPTIONS) : [];
    return { name, type, options };
  });

  const dupNames = rawHeader.map((h) => h.trim()).filter((h, i, a) => h && a.indexOf(h) !== i);
  for (const d of new Set(dupNames)) {
    warnings.push(`'${d}' 열 이름이 여러 번 나와 뒤쪽에 번호를 붙였습니다.`);
  }
  if (overWide) warnings.push(`열 수보다 셀이 많은 행이 있어 남는 셀은 버렸습니다(열 ${width}개).`);
  if (truncated > 0) warnings.push(`행이 상한(${maxRows})을 넘어 ${truncated}개를 가져오지 않습니다.`);

  const rows: PlannedBoardRow[] = kept.map((r) => ({
    cells: columns.map((c, i) => convert(c.type, r[i] ?? "")),
    contentDocPath: null,
  }));

  return {
    path: input.path,
    title: input.title,
    projectName: input.projectName,
    folderPath: input.folderPath ?? null,
    columns,
    rows,
    warnings,
  };
}

/** select 옵션 id 표의 키 — `${열 번호} ${옵션 이름}`. */
export function optionKey(colIndex: number, optionName: string): string {
  return `${colIndex} ${optionName}`;
}

/**
 * 계획된 행 → DbRow.props. 열 순서의 속성 id 와 옵션 id 표를 받는다.
 *
 * 옵션 id 를 못 찾은 select 값은 **비운다**. 이름을 그대로 넣으면 화면이
 * 옵션 id 로 알고 찾다가 실패해 빈 칸으로 보이는데, 필터·칸반은 그 값을
 * 유효한 옵션으로 세기 시작한다 — 조용히 어긋나는 쪽이 더 나쁘다.
 */
export function boardRowProps(
  board: PlannedBoard,
  propIds: string[],
  optionIds: Record<string, string>,
): Record<string, unknown>[] {
  return board.rows.map((row) => {
    const props: Record<string, unknown> = {};
    board.columns.forEach((col, i) => {
      const propId = propIds[i];
      const cell = row.cells[i];
      if (!propId || cell == null) return;
      if (col.type === "select") {
        const id = optionIds[optionKey(i, String(cell))];
        props[propId] = id ?? null;
        return;
      }
      props[propId] = cell;
    });
    return props;
  });
}

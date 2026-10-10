/* =====================================================================
   리뷰 문서 → 보드 이슈 (팀 규칙 4 "발견사항은 보드 이슈로"의 자동화)

   리뷰 doc 의 `## N. 제목` 아래 표 중 첫 열이 코드(B1·U3·P4·C2·A-5)인 행을 뽑는다.
   열 이름은 헤더로 판별하고(문서마다 열 구성이 다르다), 셀 분리는 lib/md 의
   파서(splitCells — 코드 스팬 안 `|`, `\|` 규칙)를 그대로 쓴다. 순수 모듈 — IO 는 scripts/ws.ts.
   ===================================================================== */
import { parseMarkdown } from "./md/parse";
import { inlineText, type TableCell } from "./md/ast";

export type ReviewRow = {
  code: string;
  section: string;
  severity: string | null;
  finding: string;
  evidence: string | null;
  proposal: string | null;
};

const CODE_RE = /^[A-Z]{1,2}-?\d+$/;

type Role = "severity" | "finding" | "evidence" | "proposal" | "topic" | "ignore";

/** 헤더 이름 → 역할. 위에서부터 첫 일치. */
const HEADER_ROLES: { re: RegExp; role: Role }[] = [
  { re: /심각도|severity/i, role: "severity" },
  { re: /발견|현재|문제|낭비/, role: "finding" },
  { re: /근거|측정|파일|왜/, role: "evidence" },
  { re: /제안|조치/, role: "proposal" },
  { re: /영역|항목/, role: "topic" },
];

function roleOf(header: string): Role {
  return HEADER_ROLES.find((h) => h.re.test(header))?.role ?? "ignore";
}

const text = (c: TableCell | undefined): string => (c ? inlineText(c.c) : "").replace(/\s+/g, " ").trim();

export function parseReviewTables(markdown: string): ReviewRow[] {
  const rows: ReviewRow[] = [];
  let section = "";
  for (const b of parseMarkdown(markdown).blocks) {
    if (b.t === "heading") {
      if (b.level === 2) section = inlineText(b.c).trim();
      continue;
    }
    if (b.t !== "table") continue;
    const roles = b.head.map((h) => roleOf(text(h)));
    // 열 0 은 코드 열. 발견 열이 없는 표(제안 목록: `# | 제안 | 왜 | 크기`)는 제안 열을 본문으로 쓴다.
    const hasFinding = roles.some((r, i) => i > 0 && r === "finding");
    const roleAt = (i: number): Role => (i === 0 ? "ignore" : !hasFinding && roles[i] === "proposal" ? "finding" : roles[i]);
    for (const cells of b.rows) {
      const code = text(cells[0]);
      if (!CODE_RE.test(code)) continue;
      let severity: string | null = null;
      let finding = "";
      let proposal: string | null = null;
      const evidence: string[] = [];
      cells.forEach((cell, i) => {
        const v = text(cell);
        if (!v) return;
        switch (roleAt(i)) {
          case "severity": severity = v; break;
          case "finding": finding = finding ? `${finding} ${v}` : v; break;
          case "proposal": proposal = v; break;
          case "evidence":
          case "topic": evidence.push(v); break;
        }
      });
      if (!finding) continue;
      rows.push({ code, section, severity, finding, evidence: evidence.length ? evidence.join(" · ") : null, proposal });
    }
  }
  return rows;
}

/** 첫 문장(마침표·물음표·느낌표·줄끝). 코드 스팬은 inlineText 로 이미 풀려 있다. */
function firstSentence(s: string): string {
  const m = /^(.+?[.!?。])(?:\s|$)/.exec(s);
  return (m ? m[1] : s).trim();
}

/**
 * 마크다운 강조 토큰만 벗긴다 — `**x**`·`__x__`·`*x*`·`_x_`·`~~x~~`·`==x==`.
 * 밑줄 강조는 단어 경계에서만 인정해 snake_case 같은 단어 안 밑줄은 남긴다.
 */
export function stripEmphasis(s: string): string {
  return s
    .replace(/(\*\*|~~|==)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1")
    .replace(/\*(?=[^\s*])([^*]+?)(?<=\S)\*/g, "$1")
    .replace(/(?<![\p{L}\p{N}_])_(?=[^\s_])([^_]+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, "$1");
}

export function reviewTaskTitle(prefix: string, r: ReviewRow, max = 90): string {
  const head = `${prefix} ${r.code} `;
  const full = head + firstSentence(stripEmphasis(r.finding));
  return full.length <= max ? full : `${full.slice(0, max - 1).trimEnd()}…`;
}

export function reviewTaskBody(docId: string, r: ReviewRow): string {
  const lines = [
    r.severity ? `심각도: ${r.severity}` : null,
    `발견: ${r.finding}`,
    r.evidence ? `근거: ${r.evidence}` : null,
    r.proposal ? `제안: ${r.proposal}` : null,
    `출처: /p/${docId} §${r.section}`,
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

/** 제목의 (YYYY-MM-DD) → `[리뷰 MM/DD]`, 없으면 오늘 날짜. */
export function defaultPrefix(docTitle: string, today: Date): string {
  const m = /\((\d{4})-(\d{2})-(\d{2})\)/.exec(docTitle);
  if (m) return `[리뷰 ${m[2]}/${m[3]}]`;
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return `[리뷰 ${mm}/${dd}]`;
}

/** 제목이 `${prefix} ${code}` 로 시작하는가 — 코드 뒤는 공백/끝이어야 한다(B1 이 B10 과 섞이지 않게). */
export function hasReviewTask(titles: string[], prefix: string, code: string): boolean {
  const head = `${prefix} ${code}`;
  return titles.some((t) => t === head || t.startsWith(`${head} `));
}

/** 등록 계획 — 이미 있는 제목은 건너뛰고, 같은 문서 안에서 코드가 겹쳐도 한 번만 만든다. */
export function planReviewImport(
  rows: ReviewRow[],
  existingTitles: string[],
  prefix: string,
): { create: { row: ReviewRow; title: string }[]; skipped: ReviewRow[] } {
  const titles = [...existingTitles];
  const create: { row: ReviewRow; title: string }[] = [];
  const skipped: ReviewRow[] = [];
  for (const row of rows) {
    if (hasReviewTask(titles, prefix, row.code)) {
      skipped.push(row);
      continue;
    }
    const title = reviewTaskTitle(prefix, row);
    create.push({ row, title });
    titles.push(title);
  }
  return { create, skipped };
}

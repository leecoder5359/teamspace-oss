/* 문서 폴더 이관 계획 — 순수 함수(IO 없음). 드라이런 기록·apply·undo 가 같은 계획을 쓴다. */
import { classifyDoc, type DocType, type TracksConfig } from "./docOrganize";

export type FlatLike = { id: string; title: string; kind: string; parentId: string | null; projectId: string | null; docType?: string | null; markdown?: string | null };
export type PlanRow = {
  id: string;
  title: string;
  /** 이관 전 프로젝트(null=프로젝트 없음). undo 가 복원한다. */
  fromProjectId: string | null;
  /** 이관 후 프로젝트. 프로젝트 없는 문서가 `project` 규칙에 맞으면 그 값, 아니면 fromProjectId 와 같다. */
  toProjectId: string | null;
  fromParentId: string | null;
  /** 이관 전 문서 종류(null=없음). undo 가 복원한다. */
  fromDocType: DocType | null;
  toFolder: string | null;
  docType: DocType;
  reason: string;
};
export type Plan = {
  rows: PlanRow[];
  folders: { projectId: string | null; folder: string; exists: boolean; existingId?: string }[];
  summary: { total: number; move: number; skip: number; unclassified: number };
};

/** 이관 기록 문서 제목 접두어 — scripts/organize-docs.ts 가 이 접두어로 기록을 만든다. */
export const RECORD_TITLE_PREFIX = "문서 폴더 이관 기록";

export function buildPlan(pages: readonly FlatLike[], tracks: TracksConfig): Plan {
  const parents = new Set(pages.map((p) => p.parentId).filter((x): x is string => !!x));
  // 이관 기록 문서(드라이런 포함)는 옮기지 않는다 — undo 근거이고 기록 위치에 그대로 있어야 한다.
  const targets = pages.filter((p) => p.kind === "doc" && p.parentId === null && !parents.has(p.id) && !p.title.startsWith(RECORD_TITLE_PREFIX));
  const all: PlanRow[] = targets.map((p) => {
    const r = classifyDoc({ title: p.title, head: p.markdown?.slice(0, 200), projectId: p.projectId }, tracks);
    // 분류에 실패한 문서는 프로젝트도 건드리지 않는다.
    const toProjectId = r.folder && r.projectId ? r.projectId : p.projectId;
    return { id: p.id, title: p.title, fromProjectId: p.projectId, toProjectId, fromParentId: p.parentId, fromDocType: (p.docType as DocType | null | undefined) ?? null, toFolder: r.folder, docType: r.docType, reason: r.reason };
  });
  const keyOf = (projectId: string | null, folder: string) => `${projectId}::${folder}`;
  // 이전 실행이 중간에 실패해 남은 빈 폴더(자식 없는 뿌리 문서)는 문서가 아니라 폴더로 재사용한다.
  const plannedKeys = new Set(all.filter((r) => r.toFolder).map((r) => keyOf(r.toProjectId, r.toFolder!)));
  const emptyFolderIds = new Set(
    all.filter((r) => plannedKeys.has(keyOf(r.fromProjectId, r.title))).map((r) => r.id),
  );
  const neededKeys = new Set(all.filter((r) => !emptyFolderIds.has(r.id) && r.toFolder).map((r) => keyOf(r.toProjectId, r.toFolder!)));
  for (const r of all) if (emptyFolderIds.has(r.id) && !neededKeys.has(keyOf(r.fromProjectId, r.title))) emptyFolderIds.delete(r.id);
  const rows = all.filter((r) => !emptyFolderIds.has(r.id));
  const folderKeys = new Map<string, { projectId: string | null; folder: string }>();
  for (const r of rows) if (r.toFolder) folderKeys.set(keyOf(r.toProjectId, r.toFolder), { projectId: r.toProjectId, folder: r.toFolder });
  const folders = [...folderKeys.values()].map((f) => {
    const existing = pages.find((p) => p.kind === "doc" && p.parentId === null && p.projectId === f.projectId && p.title === f.folder && (parents.has(p.id) || emptyFolderIds.has(p.id)));
    return { ...f, exists: !!existing, existingId: existing?.id };
  });
  const move = rows.filter((r) => r.toFolder).length;
  return { rows, folders, summary: { total: rows.length, move, skip: 0, unclassified: rows.length - move } };
}

/** 리허설용 — 분류된 행 앞쪽 n 건과 그 행이 쓰는 폴더만 남긴다(분류 불가 행은 뺀다). */
export function limitPlan(plan: Plan, n: number): Plan {
  const rows = plan.rows.filter((r) => r.toFolder).slice(0, Math.max(0, n));
  const keys = new Set(rows.map((r) => `${r.toProjectId}::${r.toFolder}`));
  const folders = plan.folders.filter((f) => keys.has(`${f.projectId}::${f.folder}`));
  return { rows, folders, summary: { total: rows.length, move: rows.length, skip: 0, unclassified: 0 } };
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

export function planToMarkdown(plan: Plan, projects: readonly { id: string; name: string }[], created: readonly { projectId: string | null; folder: string; id: string }[] = []): string {
  const name = (id: string | null) => projects.find((p) => p.id === id)?.name ?? "미분류";
  const lines = [
    "# 문서 폴더 이관 기록", "",
    `요약: 대상 ${plan.summary.total} · 이동 ${plan.summary.move} · 미분류 ${plan.summary.unclassified}`, "",
    "## 폴더", "", "| 프로젝트 | 폴더 | 상태 |", "|---|---|---|",
    ...plan.folders.map((f) => `| ${name(f.projectId)} | ${cell(f.folder)} | ${f.exists ? `재사용 ${f.existingId}` : "신규"} |`),
    "", "## 문서", "", "| id | 프로젝트 | 제목 | 원래 parentId | 원래 projectId | 원래 종류 | → 폴더 | 종류 | 근거 |", "|---|---|---|---|---|---|---|---|---|",
    ...plan.rows.map((r) => `| ${r.id} | ${name(r.toProjectId)} | ${cell(r.title)} | ${r.fromParentId ?? "(뿌리)"} | ${r.fromProjectId ?? "(없음)"} | ${r.fromDocType ?? "(없음)"} | ${r.toFolder ? cell(r.toFolder) : "—"} | ${r.docType} | ${cell(r.reason)} |`),
    ...(created.length ? ["", "## 생성한 폴더", "", "| 프로젝트 | 폴더 | id |", "|---|---|---|", ...created.map((c) => `| ${name(c.projectId)} | ${cell(c.folder)} | ${c.id} |`)] : []),
  ];
  return lines.join("\n") + "\n";
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** apply 결과 절 — 표 행("| ")으로 시작하지 않으므로 undo 파싱에 섞이지 않는다. */
export function applyResultSection(done: number, total: number, failure?: { id: string; reason: string }): string {
  const head = `적용 ${done}/${total}`;
  return ["## 적용 결과", "", failure ? `${head} · 실패 ${failure.id} · ${oneLine(failure.reason)}` : head, ""].join("\n");
}

/** undo 마지막 요약 — 실패는 id(사유) 목록. */
export function undoSummary(total: number, failures: readonly { id: string; reason: string }[]): string {
  const head = `되돌림 ${total - failures.length}/${total}`;
  return failures.length ? `${head}, 실패: ${failures.map((f) => `${f.id}(${oneLine(f.reason)})`).join(", ")}` : head;
}

/** undo 용 — 문서 표에서 id·원래 parentId·원래 projectId 를 복원한다. */
export function parsePlanMarkdown(md: string): { id: string; fromParentId: string | null; fromProjectId: string | null; fromDocType: DocType | null }[] {
  const out: { id: string; fromParentId: string | null; fromProjectId: string | null; fromDocType: DocType | null }[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    if (cells.length !== 9 || cells[0] === "id" || !/^[A-Za-z0-9_-]+$/.test(cells[0])) continue;
    out.push({
      id: cells[0],
      fromParentId: cells[3] === "(뿌리)" ? null : cells[3],
      fromProjectId: cells[4] === "(없음)" ? null : cells[4],
      fromDocType: cells[5] === "(없음)" ? null : (cells[5] as DocType),
    });
  }
  return out;
}

export type OrganizeArgs = { apply: boolean; limit?: number; undo?: string; project?: string; base?: string };

/** organize-docs CLI 인자 파서. 값이 필요한 플래그에 값이 없으면 던진다(조용히 전체 적용되는 사고 방지). */
export function parseOrganizeArgs(argv: readonly string[]): OrganizeArgs {
  const present = (n: string) => argv.includes(`--${n}`);
  const value = (n: string): string | undefined => {
    const i = argv.indexOf(`--${n}`);
    const v = i >= 0 ? argv[i + 1] : undefined;
    return v !== undefined && !v.startsWith("--") ? v : undefined;
  };
  const out: OrganizeArgs = { apply: present("apply") };
  if (present("undo")) {
    const v = value("undo");
    if (!v) throw new Error("--undo 에는 기록 doc id 가 필요합니다");
    out.undo = v;
  }
  if (present("limit")) {
    const v = value("limit");
    if (!v || !/^[0-9]+$/.test(v) || Number(v) < 1) throw new Error("--limit 에는 양의 정수가 필요합니다");
    if (!out.apply) throw new Error("--limit 는 --apply 와 함께 써야 합니다");
    out.limit = Number(v);
  }
  out.project = value("project");
  out.base = value("base");
  return out;
}

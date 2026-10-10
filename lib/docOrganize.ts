/* 문서 분류기 — 제목으로 트랙 폴더와 문서 종류를 판별한다. 순수 함수, IO 없음. */

export type DocType = "design" | "plan" | "brief" | "report" | "handoff" | "task_note" | "other";
export const DOC_TYPES = ["design", "plan", "brief", "report", "handoff", "task_note", "other"] as const satisfies readonly DocType[];
export type TrackRule = { folder: string; keywords: readonly string[]; docType?: DocType; /** 프로젝트 없는("__none__") 문서가 이 규칙에 맞으면 옮겨 갈 프로젝트 id. */ project?: string };
/** 키: projectId, 프로젝트 없는 문서는 "__none__". */
export type TracksConfig = Record<string, readonly TrackRule[]>;
export type ClassifyInput = { title: string; head?: string; projectId: string | null };
export type ClassifyResult = { folder: string | null; docType: DocType; reason: string; /** 맞은 규칙이 project 를 지정했을 때만 존재. */ projectId?: string };

const ICON: Record<DocType, string> = { design: "📐", plan: "🗺", brief: "📝", report: "📊", handoff: "📦", task_note: "✎", other: "📄" };

export function docTypeIcon(t: DocType | null | undefined): string {
  return t ? ICON[t] : ICON.other;
}

export function detectDocType(title: string, head = ""): DocType {
  const t = title;
  if (/^\[태스크 설명\]/.test(t)) return "task_note";
  if (/핸드오프/.test(t)) return "handoff";
  if (/브리프/.test(t)) return "brief";
  if (/(구현 계획|구현 플랜|로드맵|계획서|플랜)/.test(t)) return "plan";
  if (/(리포트|감사|조사|기록|결과|점검|대조|검토|측정|회신|분석)/.test(t)) return "report";
  if (/(설계|스펙|PRD|명세)/.test(t)) return "design";
  if (/^#\s.*(설계|design)/im.test(head)) return "design";
  return "other";
}

type Hit = { rule: TrackRule; keyword: string };

/** `^` 로 시작하는 키워드는 정규식(제목 시작), 나머지는 대소문자 무시 부분 일치. */
function matches(title: string, kw: string): boolean {
  if (kw.startsWith("^")) return new RegExp(kw).test(title);
  return title.toLowerCase().includes(kw.toLowerCase());
}

export function classifyDoc(input: ClassifyInput, tracks: TracksConfig): ClassifyResult {
  const docType = detectDocType(input.title, input.head);
  const rules = tracks[input.projectId ?? "__none__"] ?? [];
  if (docType === "task_note") {
    const r = rules.find((x) => x.docType === "task_note");
    return { folder: r?.folder ?? "태스크 설명", docType, reason: "태스크 설명 접두어", ...(r?.project ? { projectId: r.project } : {}) };
  }
  const hits: Hit[] = [];
  for (const rule of rules) {
    if (rule.docType === "task_note") continue;
    for (const kw of rule.keywords) if (matches(input.title, kw)) hits.push({ rule, keyword: kw });
  }
  if (hits.length === 0) return { folder: null, docType, reason: "일치하는 트랙 없음" };
  const byFolder = new Map<string, Hit>();
  for (const h of hits) {
    const prev = byFolder.get(h.rule.folder);
    if (!prev || h.keyword.length > prev.keyword.length) byFolder.set(h.rule.folder, h);
  }
  const ranked = [...byFolder.values()].sort((a, b) => b.keyword.length - a.keyword.length);
  if (ranked.length > 1 && ranked[0].keyword.length === ranked[1].keyword.length) {
    return { folder: null, docType, reason: `동률: ${ranked[0].rule.folder}(${ranked[0].keyword}) vs ${ranked[1].rule.folder}(${ranked[1].keyword})` };
  }
  const top = ranked[0];
  return { folder: top.rule.folder, docType: top.rule.docType ?? docType, reason: `키워드 "${top.keyword}"`, ...(top.rule.project ? { projectId: top.rule.project } : {}) };
}

export const DOC_TYPE_LABEL: Record<DocType, string> = { design: "설계", plan: "계획", brief: "브리프", report: "리포트", handoff: "핸드오프", task_note: "태스크 설명", other: "기타" };

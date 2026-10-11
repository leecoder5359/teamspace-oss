/* =====================================================================
   레슨 주간 정리 — 제안 JSON 모양·검증·병합·요약(순수).

   모양(2026-10-11 일회성 정리 제안과 같음):
     merges[{keepId, mergeIds, newTitle, newBody, reason}]  keep 을 갱신하고 mergeIds 를 지운다
     drops[{id, reason}]                                    지운다
     review[{id, reason}]                                   사람이 볼 것(적용하지 않음)
     required[{id, to: required|default, reason}]           필수로 올리기/내리기
     ondemand[{id, keywords, reason}]                       키워드가 빈 레슨에 키워드 채우기
     scopeFixes[{id, to: global|project:<id>|stack:<tag>, reason}]

   LLM 출력은 믿지 않는다 — 모양이 틀린 항목·모르는 id·남의 개인 레슨·required 삭제는 조용히 버린다.
   ===================================================================== */

import { z } from "zod";
import { lessonModeOf, parseLessonStack } from "@/lib/lessonInject";
import { normalizeTerms } from "@/lib/lessonPromptMatch";

export type Merge = { keepId: string; mergeIds: string[]; newTitle: string; newBody: string; reason: string };
export type Drop = { id: string; reason: string };
export type Review = { id: string; reason: string };
export type RequiredChange = { id: string; to: "required" | "default"; reason: string };
export type KeywordFill = { id: string; keywords: string[]; reason: string };
export type ScopeFix = { id: string; to: string; reason: string };
export type Proposal = {
  merges: Merge[];
  drops: Drop[];
  review: Review[];
  required: RequiredChange[];
  ondemand: KeywordFill[];
  scopeFixes: ScopeFix[];
};

export const emptyProposal = (): Proposal => ({ merges: [], drops: [], review: [], required: [], ondemand: [], scopeFixes: [] });

/* ── 느슨한 1차 모양(항목 단위로 걸러야 하므로 배열 원소는 unknown) ───────── */

const str = z.string().trim().min(1);
const reason = z.string().trim().max(1000).optional().default("");
const MergeS = z.object({ keepId: str, mergeIds: z.array(str).min(1), newTitle: str.max(300), newBody: str.max(8000), reason });
const DropS = z.object({ id: str, reason });
const ReviewS = z.object({ id: str, reason });
const RequiredS = z.object({ id: str, to: z.enum(["required", "default"]).optional().default("required"), reason });
const OndemandS = z.object({ id: str, keywords: z.array(z.string()).min(1), reason });
const ScopeS = z.object({ id: str, to: str, reason });
const TopS = z.object({
  merges: z.array(z.unknown()).optional(),
  drops: z.array(z.unknown()).optional(),
  review: z.array(z.unknown()).optional(),
  required: z.array(z.unknown()).optional(),
  ondemand: z.array(z.unknown()).optional(),
  scopeFixes: z.array(z.unknown()).optional(),
});

function each<T>(arr: unknown[] | undefined, s: z.ZodType<T>): T[] {
  const out: T[] = [];
  for (const x of arr ?? []) {
    const r = s.safeParse(x);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** LLM 응답 텍스트 → JSON 객체(코드펜스·앞뒤 잡담 허용). 못 읽으면 null. */
export function extractJson(text: string | null | undefined): unknown {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const a = body.indexOf("{");
  const b = body.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch {
    return null;
  }
}

/* ── 검증 ─────────────────────────────────────────────────────────── */

export type ValidateLesson = { id: string; userId: string | null; projectId: string | null; stack: string | null; mode: string | null; keywords: string[] };
export type ValidateCtx = {
  /** 워크스페이스의 레슨(개인 포함 — 개인이면 거절하려고) */
  lessons: Map<string, ValidateLesson>;
  projects: { id: string; name: string }[];
  /** 이 호출에 보여 준 레슨 id — 그 밖의 id 는 버린다(없으면 제한 없음) */
  allowedIds?: Set<string>;
};

/** "global" | "project:<id>" | "project:<이름> (<id>)" | "project:<이름>" | "stack:<tag>" → 정규형. 모르면 null. */
export function normalizeScopeTo(raw: string, projects: { id: string; name: string }[]): string | null {
  const t = raw.trim();
  const low = t.toLowerCase();
  if (low === "global" || low === "전역") return "global";
  if (low.startsWith("project:")) {
    const rest = t.slice("project:".length).trim();
    const paren = rest.match(/\(([^()\s]+)\)\s*$/);
    const cand = paren ? paren[1] : rest;
    const byId = projects.find((p) => p.id === cand);
    if (byId) return `project:${byId.id}`;
    const byName = projects.filter((p) => p.name.toLowerCase() === (paren ? rest.replace(/\([^()]*\)\s*$/, "").trim() : rest).toLowerCase());
    return byName.length === 1 ? `project:${byName[0].id}` : null;
  }
  if (low.startsWith("stack:")) {
    const st = parseLessonStack(t.slice("stack:".length).trim());
    return st.ok && st.stack ? `stack:${st.stack}` : null;
  }
  return null;
}

const currentScope = (l: ValidateLesson): string => (l.projectId ? `project:${l.projectId}` : l.stack ? `stack:${l.stack}` : "global");

/**
 * 1차 모양 → 검증된 제안. 버리는 규칙:
 * - 모양이 틀린 항목, 모르는 id·보여 주지 않은 id, 개인 레슨(누구 것이든) — 전부
 * - required 레슨을 지우는 항목(drop·merge 의 mergeIds) — 그 id 만 빼고, 남는 게 없으면 항목째
 * - 앞선 merge/drop 이 이미 지운 레슨을 다시 건드리는 항목
 * - 바뀌는 게 없는 항목(같은 범위로 scopeFix, 이미 그 mode, 이미 키워드가 있는 레슨에 채우기)
 */
export function validateProposal(raw: unknown, ctx: ValidateCtx): Proposal {
  const top = TopS.safeParse(raw);
  const out = emptyProposal();
  if (!top.success) return out;
  const p = top.data;
  const team = (id: string): ValidateLesson | null => {
    if (ctx.allowedIds && !ctx.allowedIds.has(id)) return null;
    const l = ctx.lessons.get(id);
    return l && !l.userId ? l : null;
  };
  const isRequired = (l: ValidateLesson) => lessonModeOf(l) === "required";
  const gone = new Set<string>(); // 지워질 레슨
  const kept = new Set<string>(); // merge 의 keep(갱신될 레슨) — 다른 항목이 지우지 못하게

  for (const m of each(p.merges, MergeS)) {
    const keep = team(m.keepId);
    if (!keep || gone.has(keep.id)) continue;
    const ids = [...new Set(m.mergeIds)].filter((id) => {
      const l = team(id);
      return l && id !== keep.id && !isRequired(l) && !gone.has(id) && !kept.has(id);
    });
    if (!ids.length) continue;
    kept.add(keep.id);
    for (const id of ids) gone.add(id);
    out.merges.push({ keepId: keep.id, mergeIds: ids, newTitle: m.newTitle, newBody: m.newBody, reason: m.reason });
  }
  for (const d of each(p.drops, DropS)) {
    const l = team(d.id);
    if (!l || isRequired(l) || gone.has(l.id) || kept.has(l.id)) continue;
    gone.add(l.id);
    out.drops.push({ id: l.id, reason: d.reason });
  }
  const seen = (arr: { id: string }[], id: string) => arr.some((x) => x.id === id);
  for (const r of each(p.review, ReviewS)) {
    const l = team(r.id);
    if (!l || seen(out.review, l.id)) continue;
    out.review.push({ id: l.id, reason: r.reason });
  }
  for (const r of each(p.required, RequiredS)) {
    const l = team(r.id);
    if (!l || gone.has(l.id) || seen(out.required, l.id)) continue;
    const cur = lessonModeOf(l);
    if (r.to === "required" ? cur === "required" : cur !== "required") continue;
    out.required.push({ id: l.id, to: r.to, reason: r.reason });
  }
  for (const o of each(p.ondemand, OndemandS)) {
    const l = team(o.id);
    if (!l || gone.has(l.id) || l.keywords.length > 0 || seen(out.ondemand, l.id)) continue;
    const terms = o.keywords.flatMap((k) => {
      const r = normalizeTerms([k]);
      return r.ok ? r.terms : [];
    });
    const uniq = [...new Set(terms)].slice(0, 30);
    if (!uniq.length) continue;
    out.ondemand.push({ id: l.id, keywords: uniq, reason: o.reason });
  }
  for (const s of each(p.scopeFixes, ScopeS)) {
    const l = team(s.id);
    if (!l || gone.has(l.id) || seen(out.scopeFixes, l.id)) continue;
    const to = normalizeScopeTo(s.to, ctx.projects);
    if (!to || to === currentScope(l)) continue;
    out.scopeFixes.push({ id: l.id, to, reason: s.reason });
  }
  return out;
}

/** 여러 덩어리(LLM 호출)의 제안을 합친 뒤 다시 검증 — 덩어리 사이의 충돌(같은 레슨을 둘이 지움 등)도 같은 규칙으로 거른다. */
export function mergeProposals(parts: Proposal[], ctx: Omit<ValidateCtx, "allowedIds">): Proposal {
  const all = emptyProposal();
  for (const p of parts) {
    all.merges.push(...p.merges);
    all.drops.push(...p.drops);
    all.review.push(...p.review);
    all.required.push(...p.required);
    all.ondemand.push(...p.ondemand);
    all.scopeFixes.push(...p.scopeFixes);
  }
  return validateProposal(all, ctx);
}

/** 적용할 게 있는 항목 수(review 는 제외). */
export function actionCount(p: Proposal): number {
  return p.merges.length + p.drops.length + p.required.length + p.ondemand.length + p.scopeFixes.length;
}

export function isEmptyProposal(p: Proposal): boolean {
  return actionCount(p) === 0 && p.review.length === 0;
}

/** 이 제안이 건드리는 레슨 id 전부(백업 대상). review 제외. */
export function affectedIds(p: Proposal): string[] {
  return [
    ...new Set([
      ...p.merges.flatMap((m) => [m.keepId, ...m.mergeIds]),
      ...p.drops.map((d) => d.id),
      ...p.required.map((r) => r.id),
      ...p.ondemand.map((o) => o.id),
      ...p.scopeFixes.map((s) => s.id),
    ]),
  ];
}

/** 정리 결과를 한국어 한 줄로. */
export function countsLine(p: Proposal): string {
  const removed = p.merges.reduce((n, m) => n + m.mergeIds.length, 0);
  return [
    `병합 ${p.merges.length}건(흡수 ${removed}개)`,
    `삭제 ${p.drops.length}`,
    `범위 변경 ${p.scopeFixes.length}`,
    `필수 변경 ${p.required.length}`,
    `키워드 채움 ${p.ondemand.length}`,
    `검토 ${p.review.length}`,
  ].join(" · ");
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 승인 카드 본문 — 건수 + 주요 항목(최대 top 개) + 전체 보기 링크. */
export function cardBody(p: Proposal, o: { weekKey: string; runId: string; titles: Map<string, string>; link: string; top?: number }): string {
  const t = (id: string) => cut(o.titles.get(id) ?? id, 60);
  const lines: string[] = [];
  for (const m of p.merges) lines.push(`• 병합: ${t(m.keepId)} ← ${m.mergeIds.map(t).join(", ")}`);
  for (const d of p.drops) lines.push(`• 삭제: ${t(d.id)}${d.reason ? ` — ${cut(d.reason, 60)}` : ""}`);
  for (const s of p.scopeFixes) lines.push(`• 범위: ${t(s.id)} → ${s.to}`);
  for (const r of p.required) lines.push(`• ${r.to === "required" ? "필수로" : "기본으로"}: ${t(r.id)}`);
  const top = o.top ?? 6;
  const shown = lines.slice(0, top);
  if (lines.length > top) shown.push(`… 외 ${lines.length - top}건`);
  return [
    `${o.weekKey} 레슨 정리 제안 — ${countsLine(p)}`,
    ...shown,
    p.ondemand.length ? `키워드 채움 ${p.ondemand.length}건은 전체 보기에서 확인` : "",
    `전체 보기: ${o.link}`,
    `승인하면 워커가 1분 안에 적용합니다(적용 전 백업). 되돌리기: pnpm ws lesson hygiene revert ${o.runId}`,
  ]
    .filter(Boolean)
    .join("\n");
}

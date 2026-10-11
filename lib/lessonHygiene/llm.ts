/* =====================================================================
   레슨 주간 정리 — LLM 단계(feature "lesson-hygiene").
   후보 묶음을 범위별 덩어리로 나눠 덩어리마다 한 번 호출하고, 응답은 proposal.validateProposal 로 거른다.
   LLM 이 꺼져 있거나 실패하면 그 덩어리는 결정적 폴백(신호 → review 항목)으로 떨어진다.
   ===================================================================== */

import { complete } from "@/lib/llm";
import { emptyProposal, extractJson, validateProposal, type Proposal, type ValidateCtx } from "./proposal";
import type { Cluster, HygieneLesson } from "./signals";
import { lessonModeOf } from "@/lib/lessonInject";

export const HYGIENE_FEATURE = "lesson-hygiene";
const BODY_MAX = 700;

export const HYGIENE_SYSTEM = [
  "너는 팀 작업규칙(레슨) 정리 도우미다. 주어진 레슨 묶음과 신호만 보고 정리 제안을 JSON 하나로만 답한다(설명 문장 금지).",
  "레슨은 AI 코딩 에이전트 세션에 주입되는 팀 규칙이다. 범위: global(모든 레포) · project:<id> · stack:<tag>. mode: required(항상 주입) · default · ondemand(메시지 키워드가 맞을 때만).",
  "규칙:",
  "- 같은 규칙을 말하는 레슨만 merges 로 합친다. keepId 는 남길 레슨, mergeIds 는 지울 레슨, newTitle/newBody 는 합친 결과(한국어, 두 레슨의 처방·사례를 모두 보존).",
  "- drops 는 낡았거나 코드·문서로 이미 강제돼 레슨이 필요 없을 때만. 확신이 없으면 review 에 넣는다.",
  "- required 레슨은 절대 drops·mergeIds 에 넣지 않는다. 필수가 너무 많으면 required:[{id,to:\"default\",reason}] 로 내릴 후보를 제안한다.",
  "- ondemand 인데 키워드가 없는 레슨은 ondemand:[{id,keywords:[...],reason}] 로 사용자가 메시지에 쓸 법한 단어 3~8개(2~40자, 한국어·영어 식별자)를 채운다.",
  "- 본문이 특정 프로젝트·스택 얘기인데 범위가 넓으면 scopeFixes:[{id,to:\"project:<id>\"|\"stack:<tag>\"|\"global\",reason}].",
  "- 주어진 id 만 쓴다. 할 게 없으면 빈 배열.",
  '출력 형식: {"merges":[{"keepId":"","mergeIds":[""],"newTitle":"","newBody":"","reason":""}],"drops":[{"id":"","reason":""}],"review":[{"id":"","reason":""}],"required":[{"id":"","to":"default","reason":""}],"ondemand":[{"id":"","keywords":[""],"reason":""}],"scopeFixes":[{"id":"","to":"","reason":""}]}',
].join("\n");

const scopeLabel = (l: HygieneLesson, projName: Map<string, string>) =>
  l.projectId ? `project:${l.projectId}(${projName.get(l.projectId) ?? "?"})` : l.stack ? `stack:${l.stack}` : "global";

export function buildChunkPrompt(chunk: Cluster[], lessons: Map<string, HygieneLesson>, projects: { id: string; name: string }[]): string {
  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const parts: string[] = [`프로젝트: ${projects.map((p) => `${p.name}=${p.id}`).join(", ") || "(없음)"}`, ""];
  chunk.forEach((c, i) => {
    parts.push(`## 묶음 ${i + 1}`);
    for (const r of c.reasons) parts.push(`신호 ${r}`);
    for (const id of c.lessonIds) {
      const l = lessons.get(id);
      if (!l) continue;
      const body = l.body.length > BODY_MAX ? `${l.body.slice(0, BODY_MAX)}…` : l.body;
      parts.push(`### ${l.id} [${scopeLabel(l, projName)} · ${lessonModeOf(l)}${l.keywords.length ? ` · 키워드 ${l.keywords.join(",")}` : ""}]`, `제목: ${l.title}`, body, "");
    }
  });
  return parts.join("\n");
}

/** LLM 이 없을 때(또는 실패) — 신호를 사람이 볼 review 항목으로만 남긴다(적용할 변경은 만들지 않는다). */
export function fallbackProposal(chunk: Cluster[]): Proposal {
  const p = emptyProposal();
  const seen = new Set<string>();
  for (const c of chunk) {
    if (c.scopeKey === "required") continue; // 필수 과다는 개별 레슨 문제가 아니다 — 요약 줄에서 알린다
    for (const id of c.lessonIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const rs = c.reasons.filter((r) => r.startsWith(`${id}:`)).map((r) => r.slice(id.length + 1).trim());
      p.review.push({ id, reason: rs.join(" · ") || "정리 후보" });
    }
  }
  return p;
}

export type LlmRunner = (prompt: string, opts: { system: string; feature: string; workspaceId: string }) => Promise<string | null>;

export async function proposeForChunks(
  chunks: Cluster[][],
  i: { lessons: Map<string, HygieneLesson>; projects: { id: string; name: string }[]; workspaceId: string; ctx: Omit<ValidateCtx, "allowedIds">; run?: LlmRunner },
): Promise<{ parts: Proposal[]; llmCalls: number; llmFailed: number }> {
  const run: LlmRunner = i.run ?? ((prompt, o) => complete(prompt, o));
  const parts: Proposal[] = [];
  let llmCalls = 0;
  let llmFailed = 0;
  for (const chunk of chunks) {
    const allowedIds = new Set(chunk.flatMap((c) => c.lessonIds));
    const text = await run(buildChunkPrompt(chunk, i.lessons, i.projects), { system: HYGIENE_SYSTEM, feature: HYGIENE_FEATURE, workspaceId: i.workspaceId }).catch(() => null);
    llmCalls++;
    const json = extractJson(text);
    if (json === null) {
      llmFailed++;
      parts.push(fallbackProposal(chunk));
      continue;
    }
    parts.push(validateProposal(json, { ...i.ctx, allowedIds }));
  }
  return { parts, llmCalls, llmFailed };
}

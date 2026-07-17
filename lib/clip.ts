/* =====================================================================
   웹 클리퍼 — 수집한 웹 내용을 로컬 LLM 으로 요약하고 기존 프로젝트로 자동 분류.
   프롬프트 구성과 분류 결과 파싱은 순수 함수(TDD), 분류만 LLM(lib/llm.complete).
   ===================================================================== */

export type ProjectLite = { id: string; name: string; description?: string | null };

/** 분류+요약 프롬프트(프로젝트 후보 + 수집 내용 → {projectId, summary} JSON). */
export function buildClassifyPrompt(projects: ProjectLite[], title: string, text: string): string {
  const body = (text || "").slice(0, 6000);
  const list = projects.length
    ? projects.map((p) => `- ${p.id}: ${p.name}${p.description ? ` — ${p.description}` : ""}`).join("\n")
    : "(프로젝트 없음)";
  return [
    `다음 웹 내용을 읽고 (1) 한국어 2~3문장 요약, (2) 가장 관련 있는 프로젝트의 id 를 고르라.`,
    `적합한 프로젝트가 없으면 projectId 는 빈 문자열로 두라. 목록에 없는 id 를 지어내지 마라.`,
    `출력은 오직 JSON 객체 하나. 형식: {"projectId":"<id 또는 빈문자열>","summary":"요약"}. 코드펜스·설명 금지.`,
    ``,
    `## 프로젝트 후보`,
    list,
    ``,
    `## 제목`,
    title,
    ``,
    `## 본문`,
    body,
  ].join("\n");
}

export type Classification = { projectId: string | null; summary: string };

/**
 * LLM 출력에서 분류 결과를 관대하게 파싱.
 * 첫 JSON 객체만 추출, projectId 는 validIds 에 있을 때만 채택(아니면 null), summary 는 트림.
 */
export function parseClassification(text: string, validIds: string[]): Classification {
  const empty: Classification = { projectId: null, summary: "" };
  if (!text) return empty;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }
  if (!obj || typeof obj !== "object") return empty;
  const rec = obj as Record<string, unknown>;
  const rawId = typeof rec.projectId === "string" ? rec.projectId.trim() : "";
  const projectId = rawId && validIds.includes(rawId) ? rawId : null;
  const summary = typeof rec.summary === "string" ? rec.summary.trim() : "";
  return { projectId, summary };
}

/** 저장할 문서 본문 마크다운 구성(출처·요약·원문 발췌). */
export function buildClipMarkdown(title: string, url: string, summary: string, text: string): string {
  const parts = [`# ${title}`, ``];
  if (url) parts.push(`> 출처: ${url}`, ``);
  if (summary) parts.push(summary, ``);
  const body = (text || "").trim().slice(0, 8000);
  if (body) parts.push(`---`, ``, body);
  return parts.join("\n");
}

/* =====================================================================
   문서 → 용어집 추출·병합 (B2 추출→병합 파이프라인).
   LLM 으로 용어/정의를 추출하고, 기존 용어집과 대조해 new|duplicate|conflict 로 분류한다.
   파싱·정규화·대조는 순수 함수(TDD), 추출만 LLM(lib/llm.complete).
   ===================================================================== */

export type ExtractedTerm = { term: string; definition: string };

/** 비교용 정규화(공백 접기·소문자). */
export function normalizeTerm(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * LLM 출력에서 용어 배열을 관대하게 파싱한다.
 * - 코드펜스/잡텍스트가 섞여도 첫 JSON 배열만 추출.
 * - {term, definition} 문자열 쌍만 채택, 트림·빈값 제거·정규화 기준 중복 제거(첫 항목 유지).
 */
export function parseGlossaryJson(text: string): ExtractedTerm[] {
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: ExtractedTerm[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const term = typeof rec.term === "string" ? rec.term.trim() : "";
    const definition = typeof rec.definition === "string" ? rec.definition.trim() : "";
    if (!term || !definition) continue;
    const key = normalizeTerm(term);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ term, definition });
  }
  return out;
}

export type ExistingTerm = { id: string; term: string; definition: string };
export type ProposalStatus = "new" | "duplicate" | "conflict";

export type Proposal = {
  term: string;
  definition: string;
  status: ProposalStatus;
  existingId?: string;
  existingDefinition?: string;
};

/**
 * 추출 용어를 기존 용어집과 대조.
 * - 같은 용어 없음 → new
 * - 같은 용어 + 정의 동일(정규화 후) → duplicate
 * - 같은 용어 + 정의 상이 → conflict (모순 표시·기존 정의 동봉)
 */
export function diffGlossary(extracted: ExtractedTerm[], existing: ExistingTerm[]): Proposal[] {
  const byTerm = new Map<string, ExistingTerm>();
  for (const e of existing) byTerm.set(normalizeTerm(e.term), e);

  return extracted.map((x) => {
    const match = byTerm.get(normalizeTerm(x.term));
    if (!match) return { term: x.term, definition: x.definition, status: "new" as const };
    const same = normalizeTerm(match.definition) === normalizeTerm(x.definition);
    if (same) {
      return { term: x.term, definition: x.definition, status: "duplicate" as const, existingId: match.id };
    }
    return {
      term: x.term,
      definition: x.definition,
      status: "conflict" as const,
      existingId: match.id,
      existingDefinition: match.definition,
    };
  });
}

/* ===== 엔티티(데이터모델) 추출·병합 — 용어집과 동형 ===== */

export type ExtractedEntity = { name: string; description: string; fields: string };

/** LLM 출력에서 엔티티 배열을 관대하게 파싱({name, description?, fields?[]|string}). */
export function parseEntitiesJson(text: string): ExtractedEntity[] {
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: ExtractedEntity[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) continue;
    const key = normalizeTerm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const description = typeof rec.description === "string" ? rec.description.trim() : "";
    out.push({ name, description, fields: normalizeFields(rec.fields) });
  }
  return out;
}

/** fields 를 "한 줄에 하나" 문자열로 정규화(배열·문자열·{name,type,note} 객체 허용). */
function normalizeFields(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (!Array.isArray(raw)) return "";
  const lines: string[] = [];
  for (const f of raw) {
    if (typeof f === "string") {
      const s = f.trim();
      if (s) lines.push(s);
    } else if (f && typeof f === "object") {
      const r = f as Record<string, unknown>;
      const nm = typeof r.name === "string" ? r.name.trim() : "";
      if (!nm) continue;
      const ty = typeof r.type === "string" ? r.type.trim() : "";
      const note = typeof r.note === "string" ? r.note.trim() : typeof r.description === "string" ? r.description.trim() : "";
      lines.push(`${nm}${ty ? `: ${ty}` : ""}${note ? ` — ${note}` : ""}`);
    }
  }
  return lines.join("\n");
}

export type ExistingEntity = { id: string; name: string; description: string | null; fields: string | null };
export type EntityProposal = {
  name: string;
  description: string;
  fields: string;
  status: ProposalStatus;
  existingId?: string;
  existingDescription?: string;
};

/** 엔티티 추출 vs 기존 대조. 같은 이름 + 설명 동일 → duplicate, 설명 상이 → conflict. */
export function diffEntities(extracted: ExtractedEntity[], existing: ExistingEntity[]): EntityProposal[] {
  const byName = new Map<string, ExistingEntity>();
  for (const e of existing) byName.set(normalizeTerm(e.name), e);

  return extracted.map((x) => {
    const match = byName.get(normalizeTerm(x.name));
    if (!match) return { name: x.name, description: x.description, fields: x.fields, status: "new" as const };
    const same = normalizeTerm(match.description ?? "") === normalizeTerm(x.description);
    if (same) {
      return { name: x.name, description: x.description, fields: x.fields, status: "duplicate" as const, existingId: match.id };
    }
    return {
      name: x.name,
      description: x.description,
      fields: x.fields,
      status: "conflict" as const,
      existingId: match.id,
      existingDescription: match.description ?? "",
    };
  });
}

/** 엔티티 추출 프롬프트. */
export function buildEntityPrompt(title: string, markdown: string): string {
  const body = (markdown || "").slice(0, 6000);
  return [
    `다음 문서에서 데이터 모델/도메인 엔티티(개체)와 주요 필드를 추출하라.`,
    `규칙: 문서에 실제 근거가 있는 엔티티만. 최대 10개. 설명은 한국어 80자 이내.`,
    `필드는 "이름: 타입 — 설명" 형식 문자열의 배열. 출력은 오직 JSON 배열 하나.`,
    `형식: [{"name":"엔티티","description":"설명","fields":["id: string — 식별자"]}]. 코드펜스·설명 금지.`,
    ``,
    `# ${title}`,
    body,
  ].join("\n");
}

/** 용어 추출 프롬프트(문서 본문 기반, JSON 배열만 출력하도록 유도). */
export function buildGlossaryPrompt(title: string, markdown: string): string {
  const body = (markdown || "").slice(0, 6000);
  return [
    `다음 문서에서 팀이 공유할 만한 도메인 용어/개념과 한 줄 정의를 추출하라.`,
    `규칙: 문서에 실제로 근거가 있는 것만. 일반 상식 용어 금지. 최대 12개. 정의는 한국어로 120자 이내.`,
    `출력은 오직 JSON 배열 하나. 형식: [{"term":"용어","definition":"정의"}]. 코드펜스·설명 금지.`,
    ``,
    `# ${title}`,
    body,
  ].join("\n");
}

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

/* ===== 완료 기준(DoD) 추출·병합 ===== */

export type ExtractedDodItem = { text: string };

/** LLM 출력에서 DoD 항목을 파싱한다. ["문장"] 도, [{"text":"문장"}] 도 받는다. */
export function parseDodJson(text: string): ExtractedDodItem[] {
  const arr = parseJsonArray(text);
  const out: ExtractedDodItem[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const value =
      typeof item === "string" ? item.trim() : pickString(item, "text") || pickString(item, "item");
    if (!value) continue;
    const key = normalizeTerm(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text: value });
  }
  return out;
}

export type ExistingDodItem = { id: string; text: string };
/** DoD 항목은 본문이 곧 항목이라 모순(conflict)이 성립하지 않는다 — new|duplicate 만 나온다. */
export type DodProposal = { text: string; status: ProposalStatus; existingId?: string };

/** 추출 항목을 기존 DoD 와 대조. 같은 문장(정규화)이 있으면 duplicate. */
export function diffDod(extracted: ExtractedDodItem[], existing: ExistingDodItem[]): DodProposal[] {
  const byText = new Map<string, ExistingDodItem>();
  for (const e of existing) byText.set(normalizeTerm(e.text), e);

  return extracted.map((x) => {
    const match = byText.get(normalizeTerm(x.text));
    return match
      ? { text: x.text, status: "duplicate" as const, existingId: match.id }
      : { text: x.text, status: "new" as const };
  });
}

/** DoD 추출 프롬프트. */
export function buildDodPrompt(title: string, markdown: string): string {
  return [
    `다음 문서에서 "완료의 기준(Definition of Done)" 으로 삼을 만한 체크리스트 항목을 추출하라.`,
    `규칙: 문서에 실제 근거가 있는 것만. 검증 가능한 상태로 쓴다("테스트를 통과한다" 처럼). 최대 12개.`,
    `한 항목은 한국어 80자 이내. 출력은 오직 JSON 배열 하나.`,
    `형식: [{"text":"항목"}]. 코드펜스·설명 금지.`,
    ``,
    `# ${title}`,
    clip(markdown),
  ].join("\n");
}

/* ===== 온보딩 단계 추출·병합 ===== */

export type ExtractedStep = { title: string; body: string };

/** LLM 출력에서 온보딩 단계를 파싱({title, body?}). */
export function parseOnboardingJson(text: string): ExtractedStep[] {
  const arr = parseJsonArray(text);
  const out: ExtractedStep[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const title = typeof item === "string" ? item.trim() : pickString(item, "title");
    if (!title) continue;
    const key = normalizeTerm(title);
    if (seen.has(key)) continue;
    seen.add(key);
    const body = typeof item === "string" ? "" : joinLines(readField(item, "body") ?? readField(item, "description"));
    out.push({ title, body });
  }
  return out;
}

export type ExistingStep = { id: string; title: string; body: string | null };
export type StepProposal = {
  title: string;
  body: string;
  status: ProposalStatus;
  existingId?: string;
  existingBody?: string;
};

/** 추출 단계 vs 기존 온보딩. 같은 제목 + 본문 동일 → duplicate, 본문 상이 → conflict. */
export function diffOnboarding(extracted: ExtractedStep[], existing: ExistingStep[]): StepProposal[] {
  const byTitle = new Map<string, ExistingStep>();
  for (const e of existing) byTitle.set(normalizeTerm(e.title), e);

  return extracted.map((x) => {
    const match = byTitle.get(normalizeTerm(x.title));
    if (!match) return { title: x.title, body: x.body, status: "new" as const };
    if (normalizeTerm(match.body ?? "") === normalizeTerm(x.body)) {
      return { title: x.title, body: x.body, status: "duplicate" as const, existingId: match.id };
    }
    return {
      title: x.title,
      body: x.body,
      status: "conflict" as const,
      existingId: match.id,
      existingBody: match.body ?? "",
    };
  });
}

/** 온보딩 추출 프롬프트. */
export function buildOnboardingPrompt(title: string, markdown: string): string {
  return [
    `다음 문서에서 새 팀원이 따라 할 수 있는 온보딩 단계를 순서대로 추출하라.`,
    `규칙: 문서에 실제 근거가 있는 것만. 최대 10개. 제목은 한국어 40자 이내, 설명은 200자 이내.`,
    `출력은 오직 JSON 배열 하나. 형식: [{"title":"단계","body":"설명"}]. 코드펜스·설명 금지.`,
    ``,
    `# ${title}`,
    clip(markdown),
  ].join("\n");
}

/* ===== QA 시나리오 추출·병합 ===== */

export type ExtractedScenario = { title: string; steps: string; expected: string };

/** LLM 출력에서 QA 시나리오를 파싱({title, steps?[]|string, expected?}). */
export function parseQaJson(text: string): ExtractedScenario[] {
  const arr = parseJsonArray(text);
  const out: ExtractedScenario[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    const title = typeof item === "string" ? item.trim() : pickString(item, "title");
    if (!title) continue;
    const key = normalizeTerm(title);
    if (seen.has(key)) continue;
    seen.add(key);
    const steps = typeof item === "string" ? "" : joinLines(readField(item, "steps"));
    const expected = typeof item === "string" ? "" : joinLines(readField(item, "expected") ?? readField(item, "result"));
    out.push({ title, steps, expected });
  }
  return out;
}

export type ExistingScenario = { id: string; title: string; steps: string | null; expected: string | null };
export type ScenarioProposal = {
  title: string;
  steps: string;
  expected: string;
  status: ProposalStatus;
  existingId?: string;
  existingSteps?: string;
  existingExpected?: string;
};

/** 추출 시나리오 vs 기존 QA. 같은 제목 + 단계·기대결과 동일 → duplicate, 상이 → conflict. */
export function diffQa(extracted: ExtractedScenario[], existing: ExistingScenario[]): ScenarioProposal[] {
  const byTitle = new Map<string, ExistingScenario>();
  for (const e of existing) byTitle.set(normalizeTerm(e.title), e);

  return extracted.map((x) => {
    const match = byTitle.get(normalizeTerm(x.title));
    if (!match) return { title: x.title, steps: x.steps, expected: x.expected, status: "new" as const };
    const same =
      normalizeTerm(match.steps ?? "") === normalizeTerm(x.steps) &&
      normalizeTerm(match.expected ?? "") === normalizeTerm(x.expected);
    if (same) {
      return { title: x.title, steps: x.steps, expected: x.expected, status: "duplicate" as const, existingId: match.id };
    }
    return {
      title: x.title,
      steps: x.steps,
      expected: x.expected,
      status: "conflict" as const,
      existingId: match.id,
      existingSteps: match.steps ?? "",
      existingExpected: match.expected ?? "",
    };
  });
}

/** QA 추출 프롬프트. */
export function buildQaPrompt(title: string, markdown: string): string {
  return [
    `다음 문서에서 검증해야 할 QA 테스트 시나리오를 추출하라.`,
    `규칙: 문서에 실제 근거가 있는 동작만. 최대 10개. 제목은 한국어 60자 이내.`,
    `steps 는 실행 단계 문자열의 배열, expected 는 기대 결과 한 줄.`,
    `출력은 오직 JSON 배열 하나. 형식: [{"title":"시나리오","steps":["1. …"],"expected":"기대 결과"}]. 코드펜스·설명 금지.`,
    ``,
    `# ${title}`,
    clip(markdown),
  ].join("\n");
}

/* ===== 공용 파싱 도우미 ===== */

/** 코드펜스·잡텍스트가 섞여도 첫 JSON 배열만 꺼낸다. 실패하면 빈 배열. */
function parseJsonArray(text: string): unknown[] {
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function readField(item: unknown, key: string): unknown {
  if (!item || typeof item !== "object") return undefined;
  return (item as Record<string, unknown>)[key];
}

function pickString(item: unknown, key: string): string {
  const v = readField(item, key);
  return typeof v === "string" ? v.trim() : "";
}

/** 문자열이면 그대로, 문자열 배열이면 "한 줄에 하나"로 접는다. */
function joinLines(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (!Array.isArray(raw)) return "";
  return raw
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

/** 프롬프트에 넣을 본문 길이 제한(용어·엔티티 추출과 같은 6000자). */
function clip(markdown: string): string {
  return (markdown || "").slice(0, 6000);
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

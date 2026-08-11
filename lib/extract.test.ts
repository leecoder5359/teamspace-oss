import { describe, it, expect } from "vitest";
import {
  normalizeTerm,
  parseGlossaryJson,
  diffGlossary,
  parseEntitiesJson,
  diffEntities,
  parseDodJson,
  diffDod,
  buildDodPrompt,
  parseOnboardingJson,
  diffOnboarding,
  buildOnboardingPrompt,
  parseQaJson,
  diffQa,
  buildQaPrompt,
  type ExistingTerm,
  type ExistingEntity,
  type ExistingDodItem,
  type ExistingStep,
  type ExistingScenario,
} from "./extract";

describe("normalizeTerm", () => {
  it("트림·소문자·공백 접기", () => {
    expect(normalizeTerm("  Vault  Q&A ")).toBe("vault q&a");
    expect(normalizeTerm("워커")).toBe("워커");
  });
});

describe("parseGlossaryJson", () => {
  it("순수 JSON 배열을 파싱", () => {
    const out = parseGlossaryJson('[{"term":"워커","definition":"폴링 디스패처"}]');
    expect(out).toEqual([{ term: "워커", definition: "폴링 디스패처" }]);
  });

  it("코드펜스·설명이 섞여도 첫 배열만 추출", () => {
    const text = "다음과 같습니다:\n```json\n[{\"term\":\"A\",\"definition\":\"가\"}]\n```\n끝";
    expect(parseGlossaryJson(text)).toEqual([{ term: "A", definition: "가" }]);
  });

  it("빈 term/definition 제거·트림·정규화 기준 중복 제거(첫 항목 유지)", () => {
    const text = JSON.stringify([
      { term: " A ", definition: " 가 " },
      { term: "a", definition: "다른 정의" }, // 정규화하면 중복 → 버림
      { term: "B", definition: "" }, // 빈 정의 → 제거
      { term: "", definition: "x" }, // 빈 용어 → 제거
    ]);
    expect(parseGlossaryJson(text)).toEqual([{ term: "A", definition: "가" }]);
  });

  it("배열 없음/깨진 JSON → 빈 배열", () => {
    expect(parseGlossaryJson("그냥 텍스트")).toEqual([]);
    expect(parseGlossaryJson("[broken")).toEqual([]);
    expect(parseGlossaryJson("")).toEqual([]);
  });
});

describe("diffGlossary", () => {
  const existing: ExistingTerm[] = [
    { id: "e1", term: "워커", definition: "폴링 디스패처" },
    { id: "e2", term: "Vault", definition: "워크스페이스 위키" },
  ];

  it("기존에 없으면 new", () => {
    const [p] = diffGlossary([{ term: "임베딩", definition: "벡터 표현" }], existing);
    expect(p.status).toBe("new");
    expect(p.existingId).toBeUndefined();
  });

  it("용어·정의 동일(정규화)하면 duplicate", () => {
    const [p] = diffGlossary([{ term: "워커", definition: "폴링 디스패처" }], existing);
    expect(p.status).toBe("duplicate");
    expect(p.existingId).toBe("e1");
  });

  it("용어 같고 정의 다르면 conflict + 기존 정의 동봉", () => {
    const [p] = diffGlossary([{ term: "vault", definition: "금고" }], existing);
    expect(p.status).toBe("conflict");
    expect(p.existingId).toBe("e2");
    expect(p.existingDefinition).toBe("워크스페이스 위키");
  });
});

describe("parseEntitiesJson", () => {
  it("name + 배열 fields(문자열·객체 혼용)를 줄 문자열로 정규화", () => {
    const text = JSON.stringify([
      { name: "Page", description: "문서/DB", fields: ["id: string — 식별자", { name: "title", type: "string", note: "제목" }] },
    ]);
    const [e] = parseEntitiesJson(text);
    expect(e.name).toBe("Page");
    expect(e.fields).toBe("id: string — 식별자\ntitle: string — 제목");
  });

  it("fields 가 문자열이어도 허용, name 없으면 제외, 이름 정규화 중복 제거", () => {
    const text = JSON.stringify([
      { name: "Row", description: "행", fields: "props: json" },
      { name: "row", description: "중복" },
      { description: "이름없음" },
    ]);
    const out = parseEntitiesJson(text);
    expect(out).toHaveLength(1);
    expect(out[0].fields).toBe("props: json");
  });

  it("배열 아님/깨진 입력 → 빈 배열", () => {
    expect(parseEntitiesJson("nope")).toEqual([]);
    expect(parseEntitiesJson("[broken")).toEqual([]);
  });
});

describe("diffEntities", () => {
  const existing: ExistingEntity[] = [
    { id: "x1", name: "Page", description: "문서/DB 노드", fields: "id: string" },
  ];

  it("없으면 new, 이름·설명 동일이면 duplicate, 설명 다르면 conflict", () => {
    expect(diffEntities([{ name: "Schedule", description: "예약", fields: "" }], existing)[0].status).toBe("new");
    expect(diffEntities([{ name: "Page", description: "문서/DB 노드", fields: "x" }], existing)[0].status).toBe("duplicate");
    const c = diffEntities([{ name: "page", description: "전혀 다름", fields: "" }], existing)[0];
    expect(c.status).toBe("conflict");
    expect(c.existingDescription).toBe("문서/DB 노드");
  });
});

describe("parseDodJson", () => {
  it("객체 배열과 문자열 배열을 모두 받는다", () => {
    expect(parseDodJson('[{"text":"테스트를 통과한다"}]')).toEqual([{ text: "테스트를 통과한다" }]);
    expect(parseDodJson('["린트 에러가 없다"]')).toEqual([{ text: "린트 에러가 없다" }]);
  });

  it("코드펜스가 섞여도 첫 배열만, 빈값 제거·정규화 중복 제거", () => {
    const text = "```json\n" + JSON.stringify([{ text: " 빌드가 성공한다 " }, { text: "빌드가  성공한다" }, { text: "" }]) + "\n```";
    expect(parseDodJson(text)).toEqual([{ text: "빌드가 성공한다" }]);
  });

  it("배열 아님/깨진 입력 → 빈 배열", () => {
    expect(parseDodJson("그냥 텍스트")).toEqual([]);
    expect(parseDodJson("[broken")).toEqual([]);
    expect(parseDodJson("")).toEqual([]);
  });
});

describe("diffDod", () => {
  const existing: ExistingDodItem[] = [{ id: "d1", text: "테스트를 통과한다" }];

  it("같은 문장(정규화)이 있으면 duplicate, 없으면 new", () => {
    const [dup] = diffDod([{ text: "테스트를  통과한다" }], existing);
    expect(dup.status).toBe("duplicate");
    expect(dup.existingId).toBe("d1");

    const [nw] = diffDod([{ text: "문서를 갱신한다" }], existing);
    expect(nw.status).toBe("new");
    expect(nw.existingId).toBeUndefined();
  });
});

describe("parseOnboardingJson", () => {
  it("title + body(문자열·배열·description 별칭)를 정규화", () => {
    const out = parseOnboardingJson(
      JSON.stringify([
        { title: "환경 세팅", body: ["pnpm i", "pnpm dev"] },
        { title: "계정 발급", description: "슬랙에서 요청" },
      ]),
    );
    expect(out).toEqual([
      { title: "환경 세팅", body: "pnpm i\npnpm dev" },
      { title: "계정 발급", body: "슬랙에서 요청" },
    ]);
  });

  it("제목 없으면 제외, 제목 정규화 기준 중복 제거", () => {
    const out = parseOnboardingJson(JSON.stringify([{ title: "A", body: "가" }, { title: "a", body: "나" }, { body: "제목없음" }]));
    expect(out).toEqual([{ title: "A", body: "가" }]);
  });
});

describe("diffOnboarding", () => {
  const existing: ExistingStep[] = [{ id: "s1", title: "환경 세팅", body: "pnpm i" }];

  it("없으면 new, 제목·본문 동일이면 duplicate, 본문 다르면 conflict + 기존 본문 동봉", () => {
    expect(diffOnboarding([{ title: "배포", body: "" }], existing)[0].status).toBe("new");
    expect(diffOnboarding([{ title: "환경 세팅", body: "pnpm i" }], existing)[0].status).toBe("duplicate");
    const c = diffOnboarding([{ title: "환경  세팅", body: "npm i" }], existing)[0];
    expect(c.status).toBe("conflict");
    expect(c.existingId).toBe("s1");
    expect(c.existingBody).toBe("pnpm i");
  });
});

describe("parseQaJson", () => {
  it("steps 배열을 줄 문자열로, expected 별칭(result)도 받는다", () => {
    const out = parseQaJson(
      JSON.stringify([{ title: "로그인", steps: ["로그인 페이지 열기", "구글로 로그인"], result: "대시보드로 이동" }]),
    );
    expect(out).toEqual([{ title: "로그인", steps: "로그인 페이지 열기\n구글로 로그인", expected: "대시보드로 이동" }]);
  });

  it("제목만 있어도 통과, 제목 없으면 제외", () => {
    const out = parseQaJson(JSON.stringify([{ title: "빈 시나리오" }, { steps: ["제목 없음"] }]));
    expect(out).toEqual([{ title: "빈 시나리오", steps: "", expected: "" }]);
  });
});

describe("diffQa", () => {
  const existing: ExistingScenario[] = [{ id: "q1", title: "로그인", steps: "구글로 로그인", expected: "대시보드" }];

  it("없으면 new, 단계·기대결과 모두 같으면 duplicate, 하나라도 다르면 conflict", () => {
    expect(diffQa([{ title: "결제", steps: "", expected: "" }], existing)[0].status).toBe("new");
    expect(diffQa([{ title: "로그인", steps: "구글로 로그인", expected: "대시보드" }], existing)[0].status).toBe("duplicate");
    const c = diffQa([{ title: "로그인", steps: "구글로 로그인", expected: "홈" }], existing)[0];
    expect(c.status).toBe("conflict");
    expect(c.existingId).toBe("q1");
    expect(c.existingSteps).toBe("구글로 로그인");
    expect(c.existingExpected).toBe("대시보드");
  });
});

describe("추출 프롬프트", () => {
  it("제목과 본문을 담고 본문은 6000자로 자른다", () => {
    const long = "가".repeat(7000);
    for (const build of [buildDodPrompt, buildOnboardingPrompt, buildQaPrompt]) {
      const p = build("설계 문서", long);
      expect(p).toContain("# 설계 문서");
      expect(p).toContain("JSON 배열");
      // 본문은 마지막 줄로 붙는다 — 잘린 길이만 본다
      expect(p.split("\n").at(-1)).toHaveLength(6000);
    }
  });
});

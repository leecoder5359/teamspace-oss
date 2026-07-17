import { describe, it, expect } from "vitest";
import {
  normalizeTerm,
  parseGlossaryJson,
  diffGlossary,
  parseEntitiesJson,
  diffEntities,
  type ExistingTerm,
  type ExistingEntity,
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

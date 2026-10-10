import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { applyResultSection, buildPlan, limitPlan, parseOrganizeArgs, planToMarkdown, parsePlanMarkdown, undoSummary } from "./docOrganizePlan";

// 실제 분류 사전은 private 전용(OSS 동기화에서 제외) — 없으면 사전 의존 블록만 건너뛴다.
const TRACKS_PATH = new URL("../scripts/organize/tracks.json", import.meta.url);
const HAS_TRACKS = existsSync(TRACKS_PATH);
const tracks: unknown = HAS_TRACKS ? JSON.parse(readFileSync(TRACKS_PATH, "utf8")) : {};
const BANJANG = "proj_banjang";
const LOYO = "proj_loyo";
const pages = [
  { id: "f1", title: "인증·계정", kind: "doc", parentId: null, projectId: BANJANG }, // 이미 있는 폴더(자식 있음)
  { id: "d1", title: "반장 api 인증 코어 설계", kind: "doc", parentId: null, projectId: BANJANG },
  { id: "d2", title: "폴더 안 문서", kind: "doc", parentId: "f1", projectId: BANJANG },
  { id: "d3", title: "[반장] 3D 조명 L1 — 구현 계획", kind: "doc", parentId: null, projectId: BANJANG },
  { id: "d4", title: "알 수 없는 제목", kind: "doc", parentId: null, projectId: BANJANG },
  { id: "b1", title: "ARCHI 보드", kind: "database", parentId: null, projectId: BANJANG },
];
describe.skipIf(!HAS_TRACKS)("buildPlan (tracks.json)", () => {
  it("뿌리 문서만 대상, 기존 폴더는 재사용, 보드·폴더 안 문서·분류 불가는 skip/unclassified", () => {
    const plan = buildPlan(pages as never, tracks as never);
    const d1 = plan.rows.find((r) => r.id === "d1")!;
    expect(d1.toFolder).toBe("인증·계정");
    expect(plan.folders.find((f) => f.folder === "인증·계정")).toMatchObject({ exists: true, existingId: "f1" });
    expect(plan.folders.find((f) => f.folder === "3D 뷰어")).toMatchObject({ exists: false });
    expect(plan.rows.find((r) => r.id === "d2")).toBeUndefined();
    expect(plan.rows.find((r) => r.id === "d4")!.toFolder).toBeNull();
    expect(plan.summary).toEqual({ total: 3, move: 2, skip: 0, unclassified: 1 });
  });
  it("기록 마크다운은 왕복한다(id·원래 parentId)", () => {
    const plan = buildPlan(pages as never, tracks as never);
    const md = planToMarkdown(plan, [{ id: BANJANG, name: "반장" }]);
    expect(md).toContain("| d1 |");
    expect(parsePlanMarkdown(md)).toContainEqual({ id: "d1", fromParentId: null, fromProjectId: BANJANG, fromDocType: null });
  });
  it("원래 docType 이 왕복한다(null 포함)", () => {
    const ps = [
      { id: "ta1", title: "반장 api 인증 설계", kind: "doc", parentId: null, projectId: BANJANG, docType: "design" },
      { id: "tb1", title: "반장 로그인 메모", kind: "doc", parentId: null, projectId: BANJANG },
    ];
    const rows = parsePlanMarkdown(planToMarkdown(buildPlan(ps as never, tracks as never), [{ id: BANJANG, name: "반장" }]));
    expect(rows).toContainEqual({ id: "ta1", fromParentId: null, fromProjectId: BANJANG, fromDocType: "design" });
    expect(rows).toContainEqual({ id: "tb1", fromParentId: null, fromProjectId: BANJANG, fromDocType: null });
  });
  it("이전 실패로 남은 빈 폴더는 문서가 아니라 폴더로 재사용한다", () => {
    const ps = [
      { id: "ef1", title: "인증·계정", kind: "doc", parentId: null, projectId: BANJANG },
      { id: "ed1", title: "반장 api 인증 코어 설계", kind: "doc", parentId: null, projectId: BANJANG },
    ];
    const plan = buildPlan(ps as never, tracks as never);
    expect(plan.folders).toEqual([{ projectId: BANJANG, folder: "인증·계정", exists: true, existingId: "ef1" }]);
    expect(plan.rows.map((r) => r.id)).toEqual(["ed1"]);
  });
  it("생성한 폴더 표를 기록에 덧붙여도 undo 파싱은 그대로", () => {
    const plan = buildPlan(pages as never, tracks as never);
    const md = planToMarkdown(plan, [{ id: BANJANG, name: "반장" }], [{ projectId: BANJANG, folder: "3D 뷰어", id: "newfolder1" }]);
    expect(md).toContain("## 생성한 폴더");
    expect(md).toContain("| newfolder1 |");
    expect(parsePlanMarkdown(md).map((r) => r.id)).toEqual(["d1", "d3", "d4"]);
  });
  it("limitPlan 은 분류된 앞 n건과 필요한 폴더만 남긴다", () => {
    const plan = limitPlan(buildPlan(pages as never, tracks as never), 1);
    expect(plan.rows.map((r) => r.id)).toEqual(["d1"]);
    expect(plan.folders.map((f) => f.folder)).toEqual(["인증·계정"]);
    expect(plan.summary).toEqual({ total: 1, move: 1, skip: 0, unclassified: 0 });
  });
});

describe("buildPlan (인라인 규칙)", () => {
  it("프로젝트 없는 문서는 __none__ 규칙의 project 로 toProjectId 를 받는다", () => {
    const t = { __none__: [{ folder: "예약·사이트", keywords: ["^W[0-9]+-"], project: LOYO }] };
    const plan = buildPlan([{ id: "n1", title: "W2-4 슬롯 엔진 — 구현 계획", kind: "doc", parentId: null, projectId: null }] as never, t as never);
    expect(plan.rows[0]).toMatchObject({ fromProjectId: null, toProjectId: LOYO, toFolder: "예약·사이트" });
    expect(plan.folders[0]).toMatchObject({ projectId: LOYO, folder: "예약·사이트", exists: false });
  });
  it("분류 실패한 프로젝트 없는 문서는 프로젝트를 바꾸지 않는다", () => {
    const t = { __none__: [{ folder: "x", keywords: ["^W[0-9]+-"], project: LOYO }] };
    const plan = buildPlan([{ id: "n2", title: "아무 제목", kind: "doc", parentId: null, projectId: null }] as never, t as never);
    expect(plan.rows[0]).toMatchObject({ toProjectId: null, toFolder: null });
  });
  it("마크다운 왕복에서 fromProjectId(null 포함)와 파이프 들어간 제목이 복원된다", () => {
    const t = { __none__: [{ folder: "예약·사이트", keywords: ["^W[0-9]+-"], project: LOYO }] };
    const ps = [
      { id: "cn1aaaaaaaaaaaaaaaaaaaaa", title: "W2-4 슬롯 | 엔진", kind: "doc", parentId: null, projectId: null },
      { id: "cd1aaaaaaaaaaaaaaaaaaaaa", title: "W9-1 x", kind: "doc", parentId: null, projectId: LOYO },
    ];
    const md = planToMarkdown(buildPlan(ps as never, t as never), [{ id: LOYO, name: "로요" }]);
    const rows = parsePlanMarkdown(md);
    expect(rows).toContainEqual({ id: "cn1aaaaaaaaaaaaaaaaaaaaa", fromParentId: null, fromProjectId: null, fromDocType: null });
    expect(rows).toContainEqual({ id: "cd1aaaaaaaaaaaaaaaaaaaaa", fromParentId: null, fromProjectId: LOYO, fromDocType: null });
  });
  it("이관 기록 문서(드라이런 포함)는 대상에서 빠진다", () => {
    const t = { __none__: [{ folder: "기록", keywords: ["기록"], project: LOYO }] };
    const plan = buildPlan([
      { id: "r1", title: "문서 폴더 이관 기록 2026-10-08 (드라이런)", kind: "doc", parentId: null, projectId: null },
      { id: "r2", title: "문서 폴더 이관 기록 2026-10-08", kind: "doc", parentId: null, projectId: null },
      { id: "r3", title: "회의 기록", kind: "doc", parentId: null, projectId: null },
    ] as never, t as never);
    expect(plan.rows.map((r) => r.id)).toEqual(["r3"]);
  });
});

describe("적용 결과·되돌림 요약", () => {
  it("성공은 적용 m/m, 실패는 n/m · 실패 id · 사유(한 줄)", () => {
    expect(applyResultSection(3, 3)).toBe("## 적용 결과\n\n적용 3/3\n");
    expect(applyResultSection(1, 3, { id: "d3", reason: "PATCH → 403\n권한 없음" })).toContain("적용 1/3 · 실패 d3 · PATCH → 403 권한 없음");
  });
  it("결과 절을 덧붙여도 undo 파싱 행은 그대로", () => {
    const t = { __none__: [{ folder: "예약·사이트", keywords: ["^W[0-9]+-"], project: LOYO }] };
    const md = planToMarkdown(buildPlan([{ id: "n1", title: "W2-4 x", kind: "doc", parentId: null, projectId: null }] as never, t as never), []);
    expect(parsePlanMarkdown(md + "\n" + applyResultSection(0, 1, { id: "n1", reason: "a | b" }))).toEqual(parsePlanMarkdown(md));
  });
  it("undo 요약은 되돌림 k/m 과 실패 목록", () => {
    expect(undoSummary(3, [])).toBe("되돌림 3/3");
    expect(undoSummary(3, [{ id: "a", reason: "404" }, { id: "b", reason: "403" }])).toBe("되돌림 1/3, 실패: a(404), b(403)");
  });
});

describe("parseOrganizeArgs", () => {
  it("정상 인자", () => {
    expect(parseOrganizeArgs(["--apply", "--limit", "3", "--project", "p1"])).toMatchObject({ apply: true, limit: 3, project: "p1" });
    expect(parseOrganizeArgs(["--undo", "abc"])).toMatchObject({ undo: "abc", apply: false });
    expect(parseOrganizeArgs([])).toMatchObject({ apply: false });
  });
  it("값 없는 --limit·--undo 와 잘못된 limit 는 던진다", () => {
    expect(() => parseOrganizeArgs(["--apply", "--limit"])).toThrow("--limit 에는 양의 정수가 필요합니다");
    expect(() => parseOrganizeArgs(["--apply", "--limit", "--project", "x"])).toThrow("양의 정수");
    expect(() => parseOrganizeArgs(["--apply", "--limit", "0"])).toThrow("양의 정수");
    expect(() => parseOrganizeArgs(["--apply", "--limit", "abc"])).toThrow("양의 정수");
    expect(() => parseOrganizeArgs(["--undo"])).toThrow("--undo 에는 기록 doc id 가 필요합니다");
    expect(() => parseOrganizeArgs(["--undo", "--apply"])).toThrow("기록 doc id");
    expect(() => parseOrganizeArgs(["--limit", "3"])).toThrow("--apply");
  });
});

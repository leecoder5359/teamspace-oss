import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { classifyDoc, detectDocType, docTypeIcon, type TracksConfig } from "./docOrganize";

// 실제 분류 사전·제목 픽스처는 private 전용(OSS 동기화에서 제외) — 없으면 그 블록만 건너뛴다.
const TRACKS_PATH = new URL("../scripts/organize/tracks.json", import.meta.url);
const TITLES_PATH = new URL("../scripts/organize/fixtures/titles-2026-10-08.json", import.meta.url);
const HAS_TRACKS = existsSync(TRACKS_PATH);
const HAS_TITLES = existsSync(TITLES_PATH);
const T = (HAS_TRACKS ? JSON.parse(readFileSync(TRACKS_PATH, "utf8")) : {}) as TracksConfig;
const titles: unknown = HAS_TITLES ? JSON.parse(readFileSync(TITLES_PATH, "utf8")) : [];
const BANJANG = "proj_banjang";
const LOYO = "proj_loyo";

describe("detectDocType", () => {
  it.each([
    ["반장 api 인증 코어 설계 (인증 1/3)", "design"],
    ["반장 api 인증 코어 구현 계획 (인증 1/3 · 7 태스크 TDD)", "plan"],
    ["[반장] 구현 브리프 — 자재 브랜드 관리", "brief"],
    ["로요 결제감사 리포트 2026-07-28 — 27건", "report"],
    ["인증 2/3 계정 흐름 — develop 병합 기록", "report"],
    ["[반장 핸드오프 B6] 인증·보안 설계 요약", "handoff"],
    ["[태스크 설명] [인증 코어 T7] CLI 스모크", "task_note"],
    ["PROGRESS", "other"],
  ])("%s → %s", (title, expected) => {
    expect(detectDocType(title)).toBe(expected);
  });
  it("핸드오프가 설계보다 우선한다 (접두어 [핸드오프] 는 종류가 아니라 묶음)", () => {
    expect(detectDocType("[반장 핸드오프 B1] 시스템 아키텍처 개요")).toBe("handoff");
  });
});

describe.skipIf(!HAS_TRACKS)("classifyDoc (tracks.json)", () => {
  it("태스크 설명은 프로젝트와 무관하게 '태스크 설명' 폴더·task_note", () => {
    const r = classifyDoc({ title: "[태스크 설명] [반장 api] rate limit", projectId: BANJANG }, T);
    expect(r).toMatchObject({ folder: "태스크 설명", docType: "task_note" });
  });
  it("한 트랙에만 맞으면 그 폴더", () => {
    expect(classifyDoc({ title: "반장 api 인증 코어 설계 (인증 1/3)", projectId: BANJANG }, T).folder).toBe("인증·계정");
    expect(classifyDoc({ title: "로요 나이스페이 연동 설계 (NiceProvider)", projectId: LOYO }, T).folder).toBe("결제·PG");
  });
  it("여러 트랙에 맞으면 더 긴 키워드가 이긴다, 동률이면 null", () => {
    // "3D 가구 모델 DB·admin 관리" → 3D(2자)·가구(2자)·admin(5자)·DB(2자): admin 이 가장 길다 → 어드민
    expect(classifyDoc({ title: "[반장] 3D 가구 모델 DB·admin 관리 — 구현 계획", projectId: BANJANG }, T).folder).toBe("어드민");
    const tie = classifyDoc({ title: "도면 3D", projectId: BANJANG }, T);
    expect(tie.folder).toBeNull();
    expect(tie.reason).toMatch(/동률/);
  });
  it("정규식 키워드(^) 는 제목 시작만 본다", () => {
    expect(classifyDoc({ title: "04 생일·기념일 자동 축하 메시지", projectId: LOYO }, T).folder).toBe("백로그 기능");
    expect(classifyDoc({ title: "W2-4 슬롯 엔진 — 구현 계획", projectId: LOYO }, T).folder).toBe("예약·사이트");
  });
  it("사전에 없는 프로젝트·미분류는 folder null, docType 은 판별", () => {
    const r = classifyDoc({ title: "CrewPool PRD (v1.0)", projectId: "proj_crewpool" }, T);
    expect(r.folder).toBeNull();
    expect(r.docType).toBe("design"); // "PRD" 는 design 으로 판별된다
  });
  it.skipIf(!HAS_TITLES)("실제 제목 425건: 미분류(folder null) 15% 이하, 태스크 설명은 전부 task_note", () => {
    const rows = (titles as { title: string; projectId: string | null; parentId: string | null }[]).filter((t) => !t.parentId);
    const results = rows.map((t) => classifyDoc({ title: t.title, projectId: t.projectId }, T));
    const unclassified = results.filter((r) => r.folder === null).length;
    expect(unclassified / rows.length).toBeLessThanOrEqual(0.15);
    for (const [i, r] of results.entries()) {
      if (rows[i].title.startsWith("[태스크 설명]")) expect(r.docType).toBe("task_note");
    }
  });
});

describe("docTypeIcon", () => {
  it("종류별 아이콘, null 은 기본 📄", () => {
    expect(docTypeIcon("design")).toBe("📐");
    expect(docTypeIcon("task_note")).toBe("✎");
    expect(docTypeIcon(null)).toBe("📄");
  });
});

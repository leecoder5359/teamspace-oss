import { describe, it, expect } from "vitest";
import {
  buildFeedbackClassifyPrompt,
  parseFeedbackClassification,
  sanitizeMergeAgendaId,
  selectRetryableJobs,
} from "./llmjob";

describe("buildFeedbackClassifyPrompt", () => {
  it("제출 본문과 기존 안건 목록을 프롬프트에 포함한다", () => {
    const p = buildFeedbackClassifyPrompt({
      ref: "s1", body: "예약 알림이 두 번 와요",
      agendas: [{ id: "a1", title: "예약 리마인더 개선", summary: "발송 시점 옵션" }],
    });
    expect(p).toContain("예약 알림이 두 번 와요");
    expect(p).toContain("a1");
    expect(p).toContain("JSON");
  });
});

describe("parseFeedbackClassification", () => {
  it("코드펜스 감싼 JSON 을 파싱한다", () => {
    const raw = '```json\n{"kind":"bug","mergeAgendaId":null,"title":"중복 알림","summary":"예약 알림 2회 발송","reason":"오류 신고"}\n```';
    expect(parseFeedbackClassification(raw)).toEqual({
      kind: "bug", mergeAgendaId: null, title: "중복 알림", summary: "예약 알림 2회 발송", reason: "오류 신고",
    });
  });
  it("kind 가 허용값 밖이면 null", () => {
    expect(parseFeedbackClassification('{"kind":"etc","mergeAgendaId":null,"title":"t","summary":"s","reason":"r"}')).toBeNull();
  });
  it("JSON 아님 → null", () => {
    expect(parseFeedbackClassification("모르겠어요")).toBeNull();
  });
  it("펜스 JSON 뒤에 } 포함 잡담이 붙어도 펜스 안쪽만 파싱한다", () => {
    const raw =
      '```json\n{"kind":"bug","mergeAgendaId":null,"title":"중복 알림","summary":"예약 알림 2회 발송","reason":"오류 신고"}\n```\n' +
      "참고로 이런 케이스도 있어요(예: 배열 {a: 1} 같은 잡담) — 감안 부탁드려요.";
    expect(parseFeedbackClassification(raw)).toEqual({
      kind: "bug", mergeAgendaId: null, title: "중복 알림", summary: "예약 알림 2회 발송", reason: "오류 신고",
    });
  });
  it("title 이 빈 문자열이면 null", () => {
    expect(
      parseFeedbackClassification('{"kind":"bug","mergeAgendaId":null,"title":"","summary":"s","reason":"r"}'),
    ).toBeNull();
  });
});

describe("sanitizeMergeAgendaId", () => {
  const base = { kind: "improve" as const, mergeAgendaId: null, title: "t", summary: "s", reason: "r" };
  it("mergeAgendaId 가 안건 목록에 없으면 null 로 강등한다", () => {
    const result = { ...base, mergeAgendaId: "ghost-id" };
    expect(sanitizeMergeAgendaId(result, [{ id: "a1" }, { id: "a2" }])).toEqual({ ...base, mergeAgendaId: null });
  });
  it("mergeAgendaId 가 안건 목록에 있으면 그대로 유지한다", () => {
    const result = { ...base, mergeAgendaId: "a1" };
    expect(sanitizeMergeAgendaId(result, [{ id: "a1" }, { id: "a2" }])).toEqual(result);
  });
  it("mergeAgendaId 가 null 이면 그대로 null 이다", () => {
    expect(sanitizeMergeAgendaId(base, [{ id: "a1" }])).toEqual(base);
  });
});

describe("selectRetryableJobs", () => {
  it("pending 이고 attempts < max 인 것만", () => {
    const jobs = [
      { id: "a", status: "pending", attempts: 0 },
      { id: "b", status: "pending", attempts: 3 },
      { id: "c", status: "done", attempts: 0 },
    ];
    expect(selectRetryableJobs(jobs, 3).map((j) => j.id)).toEqual(["a"]);
  });
});

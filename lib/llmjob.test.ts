import { describe, it, expect, afterEach } from "vitest";
import {
  buildFeedbackClassifyPrompt,
  parseFeedbackClassification,
  sanitizeMergeAgendaId,
  selectRetryableJobs,
  callbackPolicy,
  JOB_RETENTION_DAYS,
} from "./llmjob";
import { checkCallbackUrl } from "./callbackUrl";

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

describe("callbackPolicy — 라우트와 워커가 같은 정책을 본다 (피드백허브 후속)", () => {
  const saved = { hosts: process.env.LLM_CALLBACK_ALLOWED_HOSTS, priv: process.env.LLM_CALLBACK_ALLOW_PRIVATE };
  // process.env.X = undefined 는 문자열 "undefined" 를 넣는다 — 지우려면 delete 여야 한다.
  afterEach(() => {
    if (saved.hosts === undefined) delete process.env.LLM_CALLBACK_ALLOWED_HOSTS;
    else process.env.LLM_CALLBACK_ALLOWED_HOSTS = saved.hosts;
    if (saved.priv === undefined) delete process.env.LLM_CALLBACK_ALLOW_PRIVATE;
    else process.env.LLM_CALLBACK_ALLOW_PRIVATE = saved.priv;
  });

  it("설정이 없으면 '내부만 차단' — 공개 콜백은 계속 동작한다(기존 연동을 깨지 않는다)", () => {
    delete process.env.LLM_CALLBACK_ALLOWED_HOSTS;
    delete process.env.LLM_CALLBACK_ALLOW_PRIVATE;
    const p = callbackPolicy();
    expect(p.allowHosts).toEqual([]);
    expect(p.allowPrivate).toBe(false);
    expect(checkCallbackUrl("https://callback.example.com/cb", p).ok).toBe(true);
    expect(checkCallbackUrl("http://169.254.169.254/latest/meta-data/", p).ok).toBe(false);
  });

  it("allowlist 를 설정하면 그 호스트만", () => {
    process.env.LLM_CALLBACK_ALLOWED_HOSTS = "callback.example.com, https://hooks.example.com/x";
    const p = callbackPolicy();
    expect(p.allowHosts).toEqual(["callback.example.com", "hooks.example.com"]);
    expect(checkCallbackUrl("https://api.callback.example.com/cb", p).ok).toBe(true);
    expect(checkCallbackUrl("https://evil.com/cb", p).ok).toBe(false);
  });

  it("ALLOW_PRIVATE=true 는 로컬 개발용 탈출구", () => {
    process.env.LLM_CALLBACK_ALLOW_PRIVATE = "true";
    expect(checkCallbackUrl("http://127.0.0.1:3002/cb", callbackPolicy()).ok).toBe(true);
  });

  it("보관 기간은 30일", () => {
    expect(JOB_RETENTION_DAYS).toBe(30);
  });
});

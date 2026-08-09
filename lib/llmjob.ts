/* 비동기 LLM 잡(피드백 분류) — 상단은 순수 로직(프롬프트 빌드·응답 파싱·재시도 셀렉터, DB/네트워크 없음),
   하단은 디스패처(dispatchLlmJobs) — lib/dispatch.ts(dispatchDue)와 같은 병치 구성. */

import { prisma } from "@/lib/prisma";
import { complete } from "@/lib/llm";
import { checkCallbackUrl, parseHostAllowlist, type CallbackCheckOptions } from "@/lib/callbackUrl";

export type FeedbackClassifyPayload = {
  ref: string;
  body: string;
  agendas: { id: string; title: string; summary?: string }[];
};

export type FeedbackClassification = {
  kind: "improve" | "feature" | "bug";
  mergeAgendaId: string | null;
  title: string;
  summary: string;
  reason: string;
};

export function buildFeedbackClassifyPrompt(payload: FeedbackClassifyPayload): string {
  const agendaLines = payload.agendas
    .map((a) => `- id:${a.id} | ${a.title}${a.summary ? ` — ${a.summary}` : ""}`)
    .join("\n");
  return [
    "매장 관리 SaaS '단골노트' 사장님이 보낸 요청을 분류하라.",
    "",
    "## 요청 원문",
    payload.body,
    "",
    "## 기존 투표 안건 목록",
    agendaLines || "(없음)",
    "",
    "## 지시",
    "1. kind: improve(기존 기능 개선) | feature(신규 기능) | bug(오류 신고) 중 하나.",
    "2. mergeAgendaId: 기존 안건과 사실상 같은 요청이면 그 id, 아니면 null.",
    "3. title/summary: 투표 목록에 올릴 한 줄 제목(20자 내)과 2~3문장 설명. bug 면 증상 요약.",
    "4. reason: 판단 근거 한 문장.",
    '반드시 JSON 만 출력: {"kind":"...","mergeAgendaId":"...또는 null","title":"...","summary":"...","reason":"..."}',
  ].join("\n");
}

const KINDS = new Set(["improve", "feature", "bug"]);

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** ```json ... ``` 코드펜스 내용을 우선 파싱 시도하고, 실패 시 첫 `{` ~ 마지막 `}` greedy 매치로 폴백한다.
 *  (펜스 없이 잡담이 JSON 뒤에 붙는 경우 잡담 속 `}` 까지 삼키는 걸 막기 위해 펜스를 우선한다.) */
export function parseFeedbackClassification(raw: string): FeedbackClassification | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let j = fenced ? tryParseJsonObject(fenced[1].trim()) : null;
  if (!j) {
    const m = raw.match(/\{[\s\S]*\}/);
    j = m ? tryParseJsonObject(m[0]) : null;
  }
  if (!j) return null;
  const kind = String(j.kind || "");
  if (!KINDS.has(kind)) return null;
  const title = String(j.title || "").trim();
  const summary = String(j.summary || "").trim();
  if (!title) return null;
  const merge = j.mergeAgendaId == null || j.mergeAgendaId === "null" ? null : String(j.mergeAgendaId);
  return {
    kind: kind as FeedbackClassification["kind"],
    mergeAgendaId: merge,
    title,
    summary,
    reason: String(j.reason || "").trim(),
  };
}

/** LLM 이 환각한 mergeAgendaId 가 안건 목록에 없으면 null 로 강등한 사본을 반환한다. */
export function sanitizeMergeAgendaId(
  result: FeedbackClassification,
  agendas: { id: string }[],
): FeedbackClassification {
  if (result.mergeAgendaId == null) return result;
  const ids = new Set(agendas.map((a) => a.id));
  if (ids.has(result.mergeAgendaId)) return result;
  return { ...result, mergeAgendaId: null };
}

export function selectRetryableJobs<T extends { status: string; attempts: number }>(
  jobs: T[],
  maxAttempts = 3,
): T[] {
  return jobs.filter((j) => j.status === "pending" && j.attempts < maxAttempts);
}

// ---------------------------------------------------------------------------
// 디스패처 (DB/네트워크 사용)
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;

/** done/failed 잡을 이만큼 지나면 지운다. payload 에 사장님 원문이 들어 있어 영구보관할 이유가 없다. */
export const JOB_RETENTION_DAYS = 30;

/**
 * 콜백 정책(환경변수). 라우트와 워커가 **같은 정책**을 봐야 하므로 여기 하나로 둔다.
 *
 *   LLM_CALLBACK_ALLOWED_HOSTS  콤마 구분 호스트(비면 "내부 차단만")
 *   LLM_CALLBACK_ALLOW_PRIVATE  "true" 면 사설·루프백 허용(로컬 개발 전용)
 */
export function callbackPolicy(): CallbackCheckOptions {
  return {
    allowHosts: parseHostAllowlist(process.env.LLM_CALLBACK_ALLOWED_HOSTS),
    allowPrivate: process.env.LLM_CALLBACK_ALLOW_PRIVATE === "true",
  };
}

/** 오래된 done/failed 잡 정리. 워커가 tick 마다 부른다(지울 게 없으면 0). */
export async function purgeOldLlmJobs(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - JOB_RETENTION_DAYS * 24 * 3600 * 1000);
  const r = await prisma.llmJob.deleteMany({
    where: { status: { in: ["done", "failed"] }, updatedAt: { lt: cutoff } },
  });
  return r.count;
}

/** pending 잡을 LLM 으로 처리하고 callbackUrl 에 결과를 POST. 실패는 attempts 증가, MAX 초과 시 failed. */
export async function dispatchLlmJobs(): Promise<{ checked: number; done: number; failed: number }> {
  const jobs = await prisma.llmJob.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 10 });
  const due = selectRetryableJobs(jobs, MAX_ATTEMPTS);
  let done = 0, failed = 0;

  const policy = callbackPolicy();

  for (const job of due) {
    let ok = false;
    let result: FeedbackClassification | null = null;
    let error = "";
    try {
      const payload = job.payload as unknown as FeedbackClassifyPayload;
      /* 발송 직전에 다시 검사한다(SSRF 축소). 접수 때도 보지만, 정책이 바뀐 뒤에
         남아 있는 행·다른 경로로 들어온 행이 그대로 나가면 안 된다. 여기서 걸리면
         재시도해도 달라질 게 없으니 attempts 를 태우지 않고 바로 failed 로 둔다. */
      const gate = checkCallbackUrl(job.callbackUrl, policy);
      if (!gate.ok) {
        await prisma.llmJob.update({
          where: { id: job.id },
          data: { status: "failed", lastError: `콜백 거부: ${gate.reason}` },
        });
        failed++;
        continue;
      }
      /* 이미 result 가 있으면 LLM 을 다시 부르지 않는다. 전에는 콜백이 실패하면
         파싱까지 끝난 결과를 버려서, 재시도마다 같은 프롬프트로 LLM 을 또 불렀다
         (콜백 쪽 장애 = 같은 분류를 3번 과금). 남은 일은 재전송뿐이다. */
      const cached = job.result as unknown as FeedbackClassification | null;
      if (cached) {
        result = cached;
      } else {
        const raw = await complete(buildFeedbackClassifyPrompt(payload));
        result = raw ? parseFeedbackClassification(raw) : null;
        if (!result) error = raw ? "파싱 실패" : "LLM 응답 없음";
        else result = sanitizeMergeAgendaId(result, payload.agendas);
      }
      if (result) {
        const res = await fetch(job.callbackUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(job.callbackSecret ? { authorization: `Bearer ${job.callbackSecret}` } : {}),
          },
          body: JSON.stringify({ jobId: job.id, kind: job.kind, ref: payload.ref, ok: true, result }),
        });
        ok = res.ok;
        if (!ok) error = `callback ${res.status}`;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const exhausted = job.attempts + 1 >= MAX_ATTEMPTS;
    await prisma.llmJob.update({
      where: { id: job.id },
      data: {
        attempts: { increment: 1 },
        status: ok ? "done" : exhausted ? "failed" : "pending",
        // 콜백이 실패해도 **결과는 남긴다** — 재시도가 LLM 을 다시 부르지 않게.
        result: result ? (result as object) : undefined,
        lastError: ok ? null : error,
      },
    });
    if (ok) done++;
    else failed++;
  }
  return { checked: due.length, done, failed };
}

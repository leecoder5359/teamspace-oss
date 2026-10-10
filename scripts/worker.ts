import "dotenv/config";
import { dispatchDue } from "@/lib/dispatch";
import { notifyTasksDue } from "@/lib/notify";
import { prisma } from "@/lib/prisma";
import { dispatchLlmJobs, purgeOldLlmJobs, JOB_RETENTION_DAYS } from "@/lib/llmjob";
import { purgeOldLlmCalls, LLM_CALL_RETENTION_DAYS } from "@/lib/aiRoutes/llmCalls";
import { snapshotWeek } from "@/lib/metrics";
import { digestWeekKey, inDigestWindow, sendWeeklyDigests } from "@/lib/digest";
import { sendRehearsalReminders } from "@/lib/rehearsalReminder";
import { inRehearsalWindow, rehearsalQuarterKey } from "@/lib/rehearsalRecord";
import { purgeOldLlmCache, LLM_CACHE_RETENTION_DAYS } from "@/lib/llmCache";
import { validateEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { purgeOldLessonLogs, LESSON_LOG_RETENTION_DAYS } from "@/lib/lessonInspect/log";

/**
 * 예약/비동기 작업 워커(컨테이너 엔트리포인트).
 * 주기적으로 만기 스케줄을 스캔·디스패치한다. (DB 폴링 — redis/BullMQ 불필요)
 *
 *   pnpm worker                      # 60초 간격
 *   WORKER_INTERVAL_MS=15000 pnpm worker
 */

const envReport = validateEnv(process.env, { entry: "worker", nodeEnv: process.env.NODE_ENV });
for (const line of envReport.warnings) log.warn("env.warning", { msg: line, entry: "worker" });
for (const line of envReport.errors) log.error("env.invalid", { msg: line, entry: "worker" });
if (envReport.errors.length > 0) process.exit(1);

const INTERVAL = Math.max(5000, Number(process.env.WORKER_INTERVAL_MS) || 60_000);

let stopping = false;
/** 정리는 매 tick 이 아니라 한 시간에 한 번(지울 게 거의 없는 쿼리를 60초마다 돌릴 이유가 없다). */
let lastPurge = 0;
const PURGE_EVERY_MS = 3600_000;
/** 주간 다이제스트(F6)를 이번 프로세스에서 이미 돌린 주. 1차 가드일 뿐 — 재기동 뒤 중복은 lib/digest 의 NotifLog 마커가 막는다. */
const digestWeeks = new Set<string>();
/** 분기 복원 리허설 리마인더를 이번 프로세스에서 이미 처리한 분기. 1차 가드 — 재기동 뒤 중복은 NotifLog 마커가 막는다. */
const rehearsalQuarters = new Set<string>();

async function tick(): Promise<void> {
  try {
    // 하트비트 (W7): /api/health 가 90초 신선도로 워커 생존 판정
    await prisma.heartbeat.upsert({ where: { id: "worker" }, create: { id: "worker" }, update: { at: new Date() } });
    const r = await dispatchDue();
    if (r.ids.length > 0) {
      log.info("worker.dispatched", { msg: `dispatched ${r.ids.length} (sent ${r.sent}, failed ${r.failed}) of ${r.checked} active`, count: r.ids.length, sent: r.sent, failed: r.failed, checked: r.checked });
    }
    const llm = await dispatchLlmJobs();
    if (llm.checked) log.info("worker.llm_jobs", { msg: `llm jobs: done=${llm.done} failed=${llm.failed}`, done: llm.done, failed: llm.failed });
    // 좀비 세션 스윕(W8 agent-7): 24시간 무동기 active 세션 → ended
    const stale = await prisma.claudeSession.updateMany({
      where: { status: "active", lastSyncedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
      data: { status: "ended", endedAt: new Date() },
    });
    if (stale.count > 0) log.info("worker.stale_sessions_ended", { msg: `stale sessions ended: ${stale.count}`, count: stale.count });
    // 마감 알림(W5 task_due): 일일 1회 중복 방지는 notifyTasksDue 내부에서 처리
    const d = await notifyTasksDue();
    if (d.notified > 0) log.info("worker.task_due_notified", { msg: `task_due notified ${d.notified}`, count: d.notified });
    // 주간 다이제스트(F6): Asia/Seoul 월요일 9시대에 한 번 — 지난주(월 00:00~월 00:00, lib/digest weekRange)를 weekly_digest 규칙 채널(없으면 기본 채널)로. 시간당 정리 블록에 넣지 않은 이유 — 그 가드는
    // 직전 실행 시각 기준이라 9시대를 통째로 건너뛸 수 있다. 프로젝트 실패가 하나라도 있으면(dg.failed > 0) Set 에 넣지 않아 9시대 다음 tick 에 재시도한다 —
    // 이미 나간 프로젝트는 "sent" 마커가, 일부만 나간 프로젝트는 partial 실패 마커가 막고, 아무 데도 못 보낸 프로젝트는 마커가 없어 다시 시도된다.
    const now = new Date();
    if (inDigestWindow(now) && !digestWeeks.has(digestWeekKey(now))) {
      try {
        const dg = await sendWeeklyDigests(now);
        if (dg.failed === 0) digestWeeks.add(dg.weekKey);
        log.info("worker.weekly_digest", { msg: `weekly digest ${dg.weekKey}: sent=${dg.sent} failed=${dg.failed} skipped=${dg.skipped}`, ...dg });
      } catch (e) {
        log.warn("worker.weekly_digest_failed", { msg: "주간 다이제스트 실패", err: e });
      }
    }
    // 분기 복원 리허설 리마인더: 1·4·7·10월 첫 월요일 09:00~09:59(서버 로컬)에 관리자 받은편지함으로 한 번.
    // 실패(예외 또는 워크스페이스 실패 1건 이상)면 Set 에 넣지 않아 창 안 다음 tick 에 재시도(워크스페이스별 마커가 중복을 막음).
    if (inRehearsalWindow(now) && !rehearsalQuarters.has(rehearsalQuarterKey(now))) {
      try {
        const rh = await sendRehearsalReminders(now);
        if (rh.quarter && rh.failed === 0) rehearsalQuarters.add(rh.quarter);
        if (rh.notified > 0) log.info("worker.rehearsal_reminder", { msg: `rehearsal reminder ${rh.quarter}: notified=${rh.notified} skipped=${rh.skipped}`, ...rh });
      } catch (e) {
        log.warn("worker.rehearsal_reminder_failed", { msg: "분기 복원 리허설 리마인더 실패", err: e });
      }
    }
    // 끝난 LLM 잡 정리(피드백허브 후속) — payload 에 사장님 원문이 들어 있어 영구보관 금지
    if (Date.now() - lastPurge > PURGE_EVERY_MS) {
      lastPurge = Date.now();
      const purged = await purgeOldLlmJobs();
      if (purged > 0) log.info("worker.purged", { msg: `llm jobs purged: ${purged} (${JOB_RETENTION_DAYS}일 경과)`, kind: "llm_jobs", count: purged });
      // LLM 호출 기록(AI 실행 경로 화면) — 메타만 있지만 무한히 쌓이지 않게
      const calls = await purgeOldLlmCalls();
      if (calls > 0) log.info("worker.purged", { msg: `llm calls purged: ${calls} (${LLM_CALL_RETENTION_DAYS}일 경과)`, kind: "llm_calls", count: calls });
      // LLM 응답 캐시 — 마지막 적중이 오래된 응답은 지운다
      const cached = await purgeOldLlmCache();
      if (cached > 0) log.info("worker.purged", { msg: `llm cache purged: ${cached} (마지막 적중 ${LLM_CACHE_RETENTION_DAYS}일 경과)`, kind: "llm_cache", count: cached });
      // 레슨 주입·조회 기록(레슨 주입 점검 화면) — id·글자 수뿐이지만 무한히 쌓이지 않게
      const lessonLogs = await purgeOldLessonLogs();
      if (lessonLogs.injections + lessonLogs.reads > 0) {
        log.info("worker.purged", {
          msg: `lesson logs purged: injections=${lessonLogs.injections} reads=${lessonLogs.reads} (${LESSON_LOG_RETENTION_DAYS}일 경과)`,
          kind: "lesson_logs",
          injections: lessonLogs.injections,
          reads: lessonLogs.reads,
        });
      }
      // 주간 지표 스냅샷(피드백 루프 ①) — 이번 ISO 주 행이 있으면 건너뛰므로 시간당 가드로 충분. 한 워크스페이스 실패가 나머지를 막지 않게.
      const workspaces = await prisma.workspace.findMany({ select: { id: true } });
      for (const w of workspaces) {
        try {
          const snap = await snapshotWeek(w.id);
          if (snap.created) log.info("metrics.snapshot_created", { msg: `metrics snapshot ${snap.weekKey}`, workspaceId: w.id, weekKey: snap.weekKey });
        } catch (e) {
          log.warn("metrics.snapshot_failed", { msg: "주간 지표 스냅샷 실패", workspaceId: w.id, err: e });
        }
      }
    }
  } catch (e) {
    log.error("worker.tick_failed", { msg: "워커 tick 실패", err: e });
  }
}

async function main(): Promise<void> {
  log.info("worker.started", { msg: `started · interval ${INTERVAL}ms`, intervalMs: INTERVAL });
  // 시작 즉시 1회 처리 후 주기 반복.
  await tick();
  while (!stopping) {
    await new Promise((res) => setTimeout(res, INTERVAL));
    if (!stopping) await tick();
  }
  log.info("worker.stopped", { msg: "stopped" });
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("worker.signal", { msg: `received ${sig}, shutting down…`, signal: sig });
    stopping = true;
  });
}

void main();

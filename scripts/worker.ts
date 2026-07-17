import "dotenv/config";
import { dispatchDue } from "@/lib/dispatch";
import { notifyTasksDue } from "@/lib/notify";
import { prisma } from "@/lib/prisma";
import { dispatchLlmJobs } from "@/lib/llmjob";

/**
 * 예약/비동기 작업 워커(컨테이너 엔트리포인트).
 * 주기적으로 만기 스케줄을 스캔·디스패치한다. (DB 폴링 — redis/BullMQ 불필요)
 *
 *   pnpm worker                      # 60초 간격
 *   WORKER_INTERVAL_MS=15000 pnpm worker
 */

const INTERVAL = Math.max(5000, Number(process.env.WORKER_INTERVAL_MS) || 60_000);

let stopping = false;

function log(msg: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

async function tick(): Promise<void> {
  try {
    // 하트비트 (W7): /api/health 가 90초 신선도로 워커 생존 판정
    await prisma.heartbeat.upsert({ where: { id: "worker" }, create: { id: "worker" }, update: { at: new Date() } });
    const r = await dispatchDue();
    if (r.ids.length > 0) {
      log(`dispatched ${r.ids.length} (sent ${r.sent}, failed ${r.failed}) of ${r.checked} active`);
    }
    const llm = await dispatchLlmJobs();
    if (llm.checked) log(`llm jobs: done=${llm.done} failed=${llm.failed}`);
    // 좀비 세션 스윕(W8 agent-7): 24시간 무동기 active 세션 → ended
    const stale = await prisma.claudeSession.updateMany({
      where: { status: "active", lastSyncedAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } },
      data: { status: "ended", endedAt: new Date() },
    });
    if (stale.count > 0) log(`stale sessions ended: ${stale.count}`);
    // 마감 알림(W5 task_due): 일일 1회 중복 방지는 notifyTasksDue 내부에서 처리
    const d = await notifyTasksDue();
    if (d.notified > 0) log(`task_due notified ${d.notified}`);
  } catch (e) {
    log(`tick error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  log(`started · interval ${INTERVAL}ms`);
  // 시작 즉시 1회 처리 후 주기 반복.
  await tick();
  while (!stopping) {
    await new Promise((res) => setTimeout(res, INTERVAL));
    if (!stopping) await tick();
  }
  log("stopped");
  process.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log(`received ${sig}, shutting down…`);
    stopping = true;
  });
}

void main();

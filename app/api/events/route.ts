import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/events → SSE 이벤트 스트림 (W8 agent-4 / inv-6 푸시 단계).
 * 서버가 3초 간격으로 Activity·(내) Notification 테일을 확인해 새 항목을 push 한다.
 * 인증: 세션 쿠키 또는 x-ws-token — EventSource 는 쿠키만 보낼 수 있으므로 브라우저 전용.
 * 클라이언트(useAutoRefresh)는 이벤트 수신 시 refetch 하고, 연결 실패 시 30초 폴링으로 폴백.
 */
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;

  const encoder = new TextEncoder();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      let lastActivity = new Date();
      let lastNotif = new Date();

      const send = (event: string, data: object) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      send("hello", { ok: true });

      timer = setInterval(async () => {
        if (closed) return;
        try {
          const [acts, notifs] = await Promise.all([
            prisma.activity.findMany({
              where: { workspaceId, createdAt: { gt: lastActivity } },
              orderBy: { createdAt: "asc" },
              take: 20,
              select: { actorName: true, verb: true, targetType: true, targetTitle: true, createdAt: true },
            }),
            prisma.notification.findMany({
              where: { workspaceId, userId, createdAt: { gt: lastNotif } },
              orderBy: { createdAt: "asc" },
              take: 20,
              select: { type: true, title: true, createdAt: true },
            }),
          ]);
          for (const a of acts) {
            lastActivity = a.createdAt;
            send("activity", a);
          }
          for (const n of notifs) {
            lastNotif = n.createdAt;
            send("notification", n);
          }
          // keep-alive 주석 (프록시 타임아웃 방지)
          if (acts.length === 0 && notifs.length === 0) {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          }
        } catch {
          /* DB 순단은 다음 tick 에 재시도 */
        }
      }, 3000);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

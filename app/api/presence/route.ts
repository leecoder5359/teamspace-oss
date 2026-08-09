import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { touch, viewersOf, pruneAll, type PresenceEntry } from "@/lib/presence";

export const runtime = "nodejs";

/* =====================================================================
   프레즌스 (격차 D4) — 누가 이 문서를 보고 있나.

     POST /api/presence { pageId, editing? } → 하트비트 + 지금 있는 사람들
     GET  /api/presence?pageId=              → 지금 있는 사람들만

   **DB 에 쓰지 않는다.** 15초마다 오는 하트비트를 영구 저장할 이유가 없고,
   프로세스가 재시작되면 어차피 다시 모인다. 대신 프로세스 메모리에 두고
   상한과 TTL 로 정리한다(방문자 수만큼 무한히 쌓이면 안 된다).

   전제: 웹 프로세스가 하나다(맥미니 launchd 단일 인스턴스). 여러 인스턴스로
   늘리면 이 방식은 인스턴스별로 갈라지므로 그때 공유 저장소로 옮겨야 한다.
   ===================================================================== */

const TTL_MS = 30_000;
const MAX_ENTRIES = 5_000; // 안전판 — 정상 사용에서는 닿지 않는다

// 모듈 스코프 = 프로세스 수명. dev 의 HMR 재적재를 견디도록 globalThis 에 붙인다.
const g = globalThis as unknown as { __wsPresence?: PresenceEntry[] };
g.__wsPresence ??= [];

function all(): PresenceEntry[] {
  return g.__wsPresence!;
}
function save(list: PresenceEntry[]) {
  g.__wsPresence = list.length > MAX_ENTRIES ? list.slice(-MAX_ENTRIES) : list;
}

export async function POST(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as { pageId?: string; editing?: boolean };
  const pageId = body.pageId?.trim();
  if (!pageId) return NextResponse.json({ error: "pageId 가 필요합니다." }, { status: 400 });

  // D3: 못 보는 페이지에 존재를 알릴 수 없다(누가 여기 있는지도 정보다).
  const gate = await requirePage(guard, pageId, "view");
  if ("err" in gate) return gate.err;

  const now = Date.now();
  const next = pruneAll(
    touch(all(), { userId: guard.userId, name: guard.actor.name, pageId, at: now, editing: !!body.editing }),
    now,
    TTL_MS,
  );
  save(next);

  return NextResponse.json({
    ok: true,
    ttlMs: TTL_MS,
    viewers: viewersOf(next, pageId, now, TTL_MS, guard.userId).map((v) => ({
      userId: v.userId,
      name: v.name,
      editing: !!v.editing,
    })),
  });
}

export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const pageId = new URL(req.url).searchParams.get("pageId");
  if (!pageId) return NextResponse.json({ error: "pageId 가 필요합니다." }, { status: 400 });
  const gate = await requirePage(guard, pageId, "view");
  if ("err" in gate) return gate.err;

  const now = Date.now();
  return NextResponse.json({
    ok: true,
    ttlMs: TTL_MS,
    viewers: viewersOf(all(), pageId, now, TTL_MS, guard.userId).map((v) => ({
      userId: v.userId,
      name: v.name,
      editing: !!v.editing,
    })),
  });
}

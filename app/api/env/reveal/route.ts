import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf, NO_STORE } from "@/lib/envVault/http";
import { reveal } from "@/lib/envVault/service";

export const runtime = "nodejs";

// POST /api/env/reveal {ids} → 값 열람(관리자 로그인 세션만, 감사 기록)
export async function POST(request: Request) {
  const g = envGuard(await requireCtx("admin"), "human-admin");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { ids?: unknown };
  try {
    return NextResponse.json({ vars: await reveal(g.ctx, b.ids, metaOf(request)) }, { headers: NO_STORE });
  } catch (e) {
    return envError(e, "reveal");
  }
}

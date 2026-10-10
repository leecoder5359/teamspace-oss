import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf, NO_STORE } from "@/lib/envVault/http";
import { checkPullPurpose, pull } from "@/lib/envVault/service";

export const runtime = "nodejs";

// POST /api/env/pull {projectId, env, purpose?} → {vars:[{key,value}]}
// purpose: "pull"(기본) | "drift"(ws env drift 의 메모리 비교 — 감사 action 이 drift_read). 어느 쪽이든 감사 1행.
// 관리자 로그인 세션 또는 editor 이상 에이전트(CLI 의 파일 기록용). 응답은 캐시 금지.
export async function POST(request: Request) {
  const g = envGuard(await requireCtx("editor"), "pull");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { projectId?: unknown; env?: unknown; purpose?: unknown };
  try {
    const purpose = checkPullPurpose(b.purpose);
    return NextResponse.json({ vars: await pull(g.ctx, b.projectId, b.env, metaOf(request), purpose) }, { headers: NO_STORE });
  } catch (e) {
    return envError(e, "pull");
  }
}

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard } from "@/lib/envVault/http";
import { syncGroups } from "@/lib/envVault/service";

export const runtime = "nodejs";

// GET /api/env/sync-groups → 워크스페이스 전체 syncGroup 일관성
// {syncGroups: [{name, members: [{projectId, projectName, env, key, varId}], consistent}]}
// 서버 안에서만 값 지문을 비교한다(응답에 값·지문 없음). viewer 이상.
export async function GET() {
  const g = envGuard(await requireCtx(), "read");
  if ("err" in g) return g.err;
  try {
    return NextResponse.json({ syncGroups: await syncGroups(g.ctx) });
  } catch (e) {
    return envError(e, "sync-groups");
  }
}

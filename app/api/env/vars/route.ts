import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { setVar } from "@/lib/envVault/service";

export const runtime = "nodejs";

// PUT /api/env/vars {projectId, env, key, value, note?, syncGroup?} → 값 설정(관리자 로그인 세션만)
export async function PUT(request: Request) {
  const g = envGuard(await requireCtx("admin"), "human-admin");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as {
    projectId?: unknown; env?: unknown; key?: unknown; value?: unknown; note?: unknown; syncGroup?: unknown;
  };
  try {
    const r = await setVar(g.ctx, { projectId: b.projectId, env: b.env, key: b.key, value: b.value, note: b.note, syncGroup: b.syncGroup }, metaOf(request));
    return NextResponse.json(r);
  } catch (e) {
    return envError(e, "set");
  }
}

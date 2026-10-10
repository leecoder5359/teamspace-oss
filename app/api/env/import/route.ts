import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { requestImport } from "@/lib/envVault/service";

export const runtime = "nodejs";

// POST /api/env/import {projectId, env, vars:[{key,value}], mode?: merge|overwrite, channel?}
// → 바로 쓰지 않는다. 봉인된 대기 작업 + 고위험 승인을 만들고 {opId, approvalId, diff} 를 돌려준다.
export async function POST(request: Request) {
  const g = envGuard(await requireCtx("editor"), "editor");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { projectId?: unknown; env?: unknown; vars?: unknown; mode?: unknown; channel?: unknown };
  try {
    const r = await requestImport(g.ctx, { projectId: b.projectId, env: b.env, vars: b.vars, mode: b.mode, channel: b.channel }, metaOf(request));
    return NextResponse.json(r);
  } catch (e) {
    return envError(e, "import");
  }
}

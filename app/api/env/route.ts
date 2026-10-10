import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard } from "@/lib/envVault/http";
import { listVars } from "@/lib/envVault/service";

export const runtime = "nodejs";

// GET /api/env?projectId=&env= → 키 목록(값 없음: 버전·갱신자·syncGroup·값 길이) + 이 프로젝트의 env 목록
export async function GET(request: Request) {
  const g = envGuard(await requireCtx(), "read");
  if ("err" in g) return g.err;
  const sp = new URL(request.url).searchParams;
  try {
    return NextResponse.json(await listVars(g.ctx, { projectId: sp.get("projectId"), env: sp.get("env") }));
  } catch (e) {
    return envError(e, "list");
  }
}

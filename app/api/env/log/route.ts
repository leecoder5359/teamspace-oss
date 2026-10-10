import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard } from "@/lib/envVault/http";
import { accessLog } from "@/lib/envVault/service";

export const runtime = "nodejs";

// GET /api/env/log?projectId=&limit= → 감사 로그(최신순, 기본 50건) — 관리자
export async function GET(request: Request) {
  const g = envGuard(await requireCtx("admin"), "admin");
  if ("err" in g) return g.err;
  const sp = new URL(request.url).searchParams;
  try {
    const limit = Number(sp.get("limit")) || 50;
    return NextResponse.json({ logs: await accessLog(g.ctx, { projectId: sp.get("projectId"), limit }) });
  } catch (e) {
    return envError(e, "log");
  }
}

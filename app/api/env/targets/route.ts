import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { createTarget, listTargets } from "@/lib/envVault/push";

export const runtime = "nodejs";

// GET /api/env/targets?projectId=&env=&id= → push 대상 목록(config·기대 계정·마지막 반영 시각·키 이름. 값·지문 없음)
export async function GET(request: Request) {
  const g = envGuard(await requireCtx(), "read");
  if ("err" in g) return g.err;
  const sp = new URL(request.url).searchParams;
  try {
    return NextResponse.json({ targets: await listTargets(g.ctx, { projectId: sp.get("projectId"), env: sp.get("env"), id: sp.get("id") }) });
  } catch (e) {
    return envError(e, "targets");
  }
}

// POST /api/env/targets {projectId, env, kind: dotenv|ssm|vercel|gha, config, account?} → 대상 추가.
// 사람 세션은 admin, 에이전트는 editor 이상 — 값이 나가는 관문은 push 때의 사람 고위험 승인이다.
// config·account 는 비밀이 아니다. 비밀처럼 보이는 문자열은 400.
export async function POST(request: Request) {
  const g = envGuard(await requireCtx("editor"), "target");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { projectId?: unknown; env?: unknown; kind?: unknown; config?: unknown; account?: unknown };
  try {
    const target = await createTarget(g.ctx, { projectId: b.projectId, env: b.env, kind: b.kind, config: b.config, account: b.account }, metaOf(request));
    return NextResponse.json({ target }, { status: 201 });
  } catch (e) {
    return envError(e, "target add");
  }
}

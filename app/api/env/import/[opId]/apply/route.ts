import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { applyImport } from "@/lib/envVault/service";

export const runtime = "nodejs";

// POST /api/env/import/[opId]/apply → 사람이 승인(approved)했고 30분 안·미적용일 때만 반영
export async function POST(request: Request, ctx: { params: Promise<{ opId: string }> }) {
  const { opId } = await ctx.params;
  const g = envGuard(await requireCtx("editor"), "editor");
  if ("err" in g) return g.err;
  try {
    return NextResponse.json(await applyImport(g.ctx, opId, metaOf(request)));
  } catch (e) {
    return envError(e, "apply");
  }
}

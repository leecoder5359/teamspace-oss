import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { requireCtx } from "@/lib/workspace";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { moveRow } from "@/lib/rowMoveService";
import { failResponse } from "@/lib/serviceResult";

export const runtime = "nodejs";

// POST /api/rows/[id]/move { targetDatabaseId, dryRun?, createMissingOptions?, expectedUpdatedAt? }
// → 같은 행(id 그대로)을 다른 보드로 옮긴다. 속성은 이름+타입으로 재매핑(lib/rowMove).
// 본체(게이트·계획·트랜잭션·활동 기록)는 lib/rowMoveService.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const parsedBody = await readBody(
    req,
    z.object({
      targetDatabaseId: z.string().optional(),
      dryRun: z.boolean().optional(),
      createMissingOptions: z.boolean().optional(),
      expectedUpdatedAt: z.string().optional(),
    }),
  );
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data;
  const targetId = typeof body.targetDatabaseId === "string" ? body.targetDatabaseId.trim() : "";
  if (!targetId) return NextResponse.json({ error: "targetDatabaseId 가 필요합니다." }, { status: 400 });

  const result = await moveRow(guard, id, {
    targetId,
    dryRun: body.dryRun === true,
    createMissingOptions: body.createMissingOptions === true,
    expectedUpdatedAt: body.expectedUpdatedAt,
  });
  if (!result.ok) return failResponse(result);
  // 다른 보드로 옮기면 그 행이 보이는 사람이 바뀐다(pageAccess(databasePageId)) — 그래프 캐시를 즉시 비운다.
  if (!result.dryRun) invalidateGraphCache(guard.workspaceId);
  return NextResponse.json(result);
}

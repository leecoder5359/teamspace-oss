import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Ctx } from "@/lib/workspace";

/**
 * 쓰기 멱등성 (W8 agent-11/18, opt-in).
 * 클라이언트가 `Idempotency-Key` 헤더를 보내면, 같은 키의 재요청에 저장된 응답을 그대로 돌려준다
 * — 네트워크 재시도로 태스크/문서가 이중 생성되는 것을 방지. 키는 워크스페이스+액터로 스코프.
 *
 * 사용:
 *   const idem = await withIdempotency(req, guard, () => 실제생성());
 *   return idem; // NextResponse
 */
export async function withIdempotency(
  req: Request,
  ctx: Ctx,
  create: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const raw = req.headers.get("idempotency-key")?.trim();
  if (!raw) return create();

  const key = createHash("sha256").update(`${ctx.workspaceId}:${ctx.userId}:${raw}`).digest("hex");
  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } }).catch(() => null);
  if (existing) {
    return NextResponse.json(existing.response as object, { headers: { "x-idempotent-replay": "1" } });
  }

  const res = await create();
  // 성공 응답(2xx)만 기록 — 실패는 재시도가 가능해야 한다
  if (res.ok) {
    const body = (await res.clone().json().catch(() => null)) as object | null;
    if (body) {
      await prisma.idempotencyRecord
        .create({ data: { key, workspaceId: ctx.workspaceId, response: body } })
        .catch(() => {}); // 동시 재시도 경쟁은 무해(먼저 쓴 쪽이 남음)
    }
  }
  return res;
}

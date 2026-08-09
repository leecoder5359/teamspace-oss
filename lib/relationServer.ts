import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeIds, partitionKnown } from "@/lib/relation";

/* =====================================================================
   relation 값 검증 (격차 C2) — 라우트가 공유하는 서버 측 헬퍼.

   행을 만들 때(rows POST)와 고칠 때(rows PATCH) 같은 검증을 해야 한다.
   한쪽만 막으면 다른 쪽으로 들어온 쓰레기 id 가 화면에 "(삭제된 행)" 으로
   영원히 남는다. 그래서 두 라우트가 이 함수 하나를 쓴다.
   ===================================================================== */

/**
 * props 안의 relation 값들을 검증하고 정규화한 props 를 돌려준다.
 * 대상 보드에 없는 행 id 가 섞여 있으면 **400** — 조용히 버리지 않는다.
 */
export async function validateRelationProps(
  databasePageId: string,
  props: Record<string, unknown>,
): Promise<{ ok: true; props: Record<string, unknown> } | { ok: false; err: NextResponse }> {
  const relProps = await prisma.dbProperty.findMany({
    where: { databasePageId, type: "relation" },
    select: { id: true, name: true, config: true },
  });
  if (relProps.length === 0) return { ok: true, props };

  const out = { ...props };
  for (const p of relProps) {
    if (!(p.id in props)) continue;
    const ids = normalizeIds(props[p.id]);
    if (ids.length === 0) {
      out[p.id] = [];
      continue;
    }
    const targetId = (p.config as { targetDatabaseId?: string } | null)?.targetDatabaseId;
    if (!targetId) {
      return {
        ok: false,
        err: NextResponse.json(
          { error: `'${p.name}' 속성에 대상 보드(targetDatabaseId)가 설정돼 있지 않습니다.`, propertyId: p.id },
          { status: 400 },
        ),
      };
    }
    const rows = await prisma.dbRow.findMany({
      where: { databasePageId: targetId, id: { in: ids } },
      select: { id: true },
    });
    const { unknown } = partitionKnown(ids, new Set(rows.map((r) => r.id)));
    if (unknown.length) {
      return {
        ok: false,
        err: NextResponse.json(
          {
            error: `'${p.name}' 에 대상 보드에 없는 행이 있습니다.`,
            propertyId: p.id,
            targetDatabaseId: targetId,
            unknownRowIds: unknown,
          },
          { status: 400 },
        ),
      };
    }
    out[p.id] = ids;
  }
  return { ok: true, props: out };
}

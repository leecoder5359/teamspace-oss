import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage, gatePage } from "@/lib/pageGuard";

export const runtime = "nodejs";

// multiselect 는 여전히 **생성 차단**이다(전수조사 D18) — 저장·렌더링이 단일값이라
// 만들 수 있게 두면 "만들었는데 그렇게 동작하지 않는" 계약 위반이 된다.
//
// relation 은 격차 C2 에서 구현해 **봉인을 풀었다**. 봉인된 동안 `pnpm ws task block`
// (SKILL.md 가 광고하던 의존관계 명령)이 400 으로 죽어 있었다 — 계약과 구현이
// 어긋나면 결국 어느 쪽이 거짓말인지를 사용자가 밟아서 알게 된다.
// 생성 시 `config.targetDatabaseId`(가리킬 보드)가 필수다.
const CREATABLE_TYPES = ["text", "number", "date", "select", "checkbox", "person", "relation"] as const;
// 스키마의 PropType 전체 — 기존 행을 읽을 때의 타입 유니온용(생성 허용 목록은 위 CREATABLE_TYPES)
type PropTypeName = "text" | "number" | "date" | "select" | "multiselect" | "checkbox" | "person" | "relation";
type PropTypeStr = PropTypeName;

async function loadBoard(id: string, workspaceId: string) {
  const page = await prisma.page.findUnique({
    where: { id },
    select: { kind: true, workspaceId: true, deletedAt: true },
  });
  if (!page || page.kind !== "database" || page.workspaceId !== workspaceId || page.deletedAt) return null;
  return page;
}

// POST /api/databases/[id]/properties { name, type, config? } → 속성 추가 (W5 task-7)
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;
  if (!(await loadBoard(id, guard.workspaceId))) {
    return NextResponse.json({ error: "Not a database" }, { status: 404 });
  }
  const parsedBody = await readBody(
    req,
    z.object({
      name: z.string().optional(),
      type: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
    }),
  );
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data as { name?: string; type?: PropTypeStr; config?: object };
  const name = body.name?.trim() ?? "";
  if (!name) return NextResponse.json({ error: "name 이 필요합니다." }, { status: 400 });
  if (!body.type || !(CREATABLE_TYPES as readonly string[]).includes(body.type)) {
    return NextResponse.json({ error: `type 은 ${CREATABLE_TYPES.join("/")} 중 하나여야 합니다. (multiselect·relation 은 미구현이라 생성 차단)` }, { status: 400 });
  }
  // relation: 가리킬 보드를 검증한다. 없는 보드/문서/남의 워크스페이스를 가리키면
  // 값 검증이 통째로 무의미해지므로 여기서 막는다(D3 게이트도 함께 통과해야 한다).
  let relationTarget: string | null = null;
  if (body.type === "relation") {
    const target = (body.config as { targetDatabaseId?: unknown } | undefined)?.targetDatabaseId;
    if (typeof target !== "string" || !target.trim()) {
      return NextResponse.json({ error: "relation 속성에는 config.targetDatabaseId(가리킬 보드)가 필요합니다." }, { status: 400 });
    }
    relationTarget = target.trim();
    if (!(await loadBoard(relationTarget, guard.workspaceId))) {
      return NextResponse.json({ error: "대상 보드를 찾을 수 없습니다." }, { status: 400 });
    }
    // 위에서 만든 색인을 재사용한다 — 같은 요청에서 접근 색인을 두 번 읽던 유일한 자리였다
    // (워크스페이스 페이지 전체를 읽는 비용이라, 20000행 기준 22ms 를 한 번 더 내고 있었다).
    const targetGate = gatePage(gate.idx, relationTarget, "view");
    if ("err" in targetGate) return targetGate.err;
  }

  const dup = await prisma.dbProperty.findFirst({ where: { databasePageId: id, name }, select: { id: true } });
  if (dup) return NextResponse.json({ error: "같은 이름의 속성이 이미 있습니다." }, { status: 409 });

  const last = await prisma.dbProperty.findFirst({
    where: { databasePageId: id },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  // select 계열 기본 config: 빈 옵션 목록
  const config =
    body.type === "relation"
      ? { targetDatabaseId: relationTarget }
      : (body.config ?? (body.type === "select" || body.type === "multiselect" ? { options: [] } : {}));
  const property = await prisma.dbProperty.create({
    data: { databasePageId: id, name, type: body.type, config: config as object, position: (last?.position ?? -1) + 1 },
  });
  return NextResponse.json({ property });
}

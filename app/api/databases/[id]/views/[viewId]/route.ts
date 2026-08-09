import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { sanitizeFilterGroup, type FilterGroup } from "@/lib/dbFilter";
import { AGG_FNS } from "@/lib/aggregate";

export const runtime = "nodejs";

/* =====================================================================
   PATCH/DELETE /api/databases/[id]/views/[viewId]

   격차조사 C5: DbView.config 에 `{ filters, sort, groupBy }` 를 담기로 스키마에
   자리를 잡아 뒀는데 **저장할 API 가 없었다**. 그래서 정렬은 컴포넌트 로컬
   useState 로만 살아 있었고 새로고침하면 사라졌다 — 저장되지 않는 뷰는 뷰라고
   부를 수 없다.

   config 는 통째로 덮지 않고 **넘어온 키만 병합**한다. 정렬만 바꿨는데 필터가
   날아가면 그게 또 조용한 데이터 손실이다.
   ===================================================================== */

// 격차 C1: 표·칸반 2종뿐이던 것에 갤러리·리스트·달력·타임라인 추가.
const VIEW_TYPES = ["table", "kanban", "gallery", "list", "calendar", "timeline"] as const;

export type ViewConfig = {
  sort?: { propId: string; dir: "asc" | "desc" } | null;
  filters?: Record<string, string>;
  groupBy?: string | null;
  /** 행 메타 가상 열(만든/수정 시각·사람) 표시 목록 — 격차 C3 */
  meta?: string[];
  /** 복합 필터(AND/OR + 연산자) — 격차 C4. 위의 legacy `filters` 를 대체한다. */
  filter?: FilterGroup | null;
  /** 달력·타임라인이 기준으로 삼을 날짜 속성 — 격차 C1. 없으면 첫 date 속성. */
  dateProp?: string | null;
  /** 타임라인 종료 날짜 속성 — 격차 C1. 없으면 시작 다음의 date 속성. */
  endProp?: string | null;
  /** 열별 집계 함수 — 격차 C6. { propId: "sum" | "avg" | … } */
  agg?: Record<string, string>;
};

/** 화면에 낼 수 있는 메타 열. 여기 없는 값은 버린다. */
const META_KEYS = ["createdAt", "updatedAt", "createdBy", "updatedBy"] as const;

/** 신뢰할 수 없는 입력에서 config 로 쓸 수 있는 부분만 골라낸다. */
export function sanitizeViewConfig(raw: unknown): ViewConfig {
  const out: ViewConfig = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;

  if ("sort" in r) {
    const s = r.sort as { propId?: unknown; dir?: unknown } | null;
    out.sort =
      s && typeof s.propId === "string" && (s.dir === "asc" || s.dir === "desc")
        ? { propId: s.propId, dir: s.dir }
        : null;
  }
  if ("filters" in r) {
    const f = r.filters;
    out.filters =
      f && typeof f === "object" && !Array.isArray(f)
        ? Object.fromEntries(
            Object.entries(f as Record<string, unknown>)
              .filter(([, v]) => typeof v === "string")
              .map(([k, v]) => [k, v as string]),
          )
        : {};
  }
  if ("groupBy" in r) {
    out.groupBy = typeof r.groupBy === "string" && r.groupBy ? r.groupBy : null;
  }
  if ("filter" in r) {
    out.filter = sanitizeFilterGroup(r.filter);
  }
  for (const k of ["dateProp", "endProp"] as const) {
    if (k in r) out[k] = typeof r[k] === "string" && r[k] ? (r[k] as string) : null;
  }
  if ("agg" in r) {
    // 알 수 없는 함수 이름이 저장되면 화면이 빈 칸을 그린다 — 화이트리스트로 거른다.
    const a = r.agg;
    out.agg =
      a && typeof a === "object" && !Array.isArray(a)
        ? Object.fromEntries(
            Object.entries(a as Record<string, unknown>).filter(
              ([, v]) => typeof v === "string" && (AGG_FNS as readonly string[]).includes(v),
            ) as [string, string][],
          )
        : {};
  }
  if ("meta" in r) {
    // 알 수 없는 키가 저장되면 화면이 빈 열을 그린다 — 화이트리스트로 거른다
    out.meta = Array.isArray(r.meta)
      ? [...new Set(r.meta.filter((v): v is string => typeof v === "string" && (META_KEYS as readonly string[]).includes(v)))]
      : [];
  }
  return out;
}

async function loadView(id: string, viewId: string, workspaceId: string) {
  const view = await prisma.dbView.findUnique({
    where: { id: viewId },
    include: { database: { select: { id: true, workspaceId: true } } },
  });
  if (!view || view.databasePageId !== id || view.database.workspaceId !== workspaceId) return null;
  return view;
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; viewId: string }> }) {
  const { id, viewId } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;

  const view = await loadView(id, viewId, guard.workspaceId);
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { name?: string; type?: string; config?: unknown };

  if (body.name !== undefined && !body.name.trim()) {
    return NextResponse.json({ error: "뷰 이름을 입력해 주세요." }, { status: 400 });
  }
  if (body.type !== undefined && !(VIEW_TYPES as readonly string[]).includes(body.type)) {
    return NextResponse.json({ error: `type 은 ${VIEW_TYPES.join("/")} 중 하나여야 합니다.` }, { status: 400 });
  }

  // 넘어온 키만 병합 — 정렬을 바꿨다고 필터가 사라지면 안 된다
  const prev = (view.config as ViewConfig) ?? {};
  const incoming = body.config === undefined ? undefined : sanitizeViewConfig(body.config);
  const merged =
    incoming === undefined
      ? undefined
      : {
          ...prev,
          ...incoming,
          // agg 만은 **열 단위로** 병합한다. 통째로 갈아끼우면, 두 열의 집계를
          // 빠르게 연달아 바꿀 때 응답 순서가 뒤바뀌며 한쪽이 사라진다
          // (브라우저 검증에서 실제로 재현됐다). 'none' 은 해제 신호라 지운다.
          ...(incoming.agg !== undefined
            ? {
                agg: Object.fromEntries(
                  Object.entries({ ...(prev.agg ?? {}), ...incoming.agg }).filter(([, v]) => v && v !== "none"),
                ),
              }
            : {}),
        };

  const updated = await prisma.dbView.update({
    where: { id: viewId },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.type !== undefined ? { type: body.type as (typeof VIEW_TYPES)[number] } : {}),
      ...(merged !== undefined ? { config: merged as object } : {}),
    },
  });
  return NextResponse.json({ view: updated });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; viewId: string }> }) {
  const { id, viewId } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;

  const view = await loadView(id, viewId, guard.workspaceId);
  if (!view) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const count = await prisma.dbView.count({ where: { databasePageId: id } });
  if (count <= 1) {
    // 마지막 뷰를 지우면 보드를 볼 방법이 없어진다
    return NextResponse.json({ error: "마지막 뷰는 삭제할 수 없습니다." }, { status: 400 });
  }
  await prisma.dbView.delete({ where: { id: viewId } });
  return NextResponse.json({ ok: true });
}

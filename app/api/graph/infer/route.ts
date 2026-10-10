import { NextResponse } from "next/server";
import { z } from "zod";
import { readBody } from "@/lib/apiBody";
import { selectInferTargets } from "@/lib/graphInferTargets";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { invalidateGraphCache, loadGraph } from "@/lib/graphLoad";
import { weakDocs } from "@/lib/graphInsights";
import { complete, resolveProvider } from "@/lib/llm";
import { buildRelatedPrompt, parseRelated, rankCandidates } from "@/lib/graphInfer";
import { buildIndex } from "@/lib/vector";

export const runtime = "nodejs";

const bodySchema = z.object({
  limit: z.number().optional(), // 숫자가 아니면 400, 범위 밖은 1..20 으로 자른다(옛 동작)
  dryRun: z.boolean().optional(),
  retry: z.boolean().optional(), // 호환 — retryBefore = 지금
  retryBefore: z.iso.datetime().optional(), // 이 시각 이전에 시도한 문서만 다시
  exclude: z.unknown().optional(), // 옛 CLI 호환 — 받아서 무시한다(시도 기록은 Page.inferTriedAt)
});

// POST /api/graph/infer { limit?=5 (1..20 으로 클램프), dryRun?, retry? }
//   결정적 근거(링크·id·제목 언급·폴더·짝)가 하나도 없는 문서에 LLM 이 연관 문서 ≤3 을 고른다 → GraphEdge(related, 모호).
//   → { ok, processed:[{id,title,related:[{id,title,reason}]}], remaining, skippedTried }
//   문서당 1회만: LLM 응답을 받으면(연관 0개여도) Page.inferTriedAt 을 찍고 다음부터 건너뛴다. retryBefore(ISO) 이전에 시도한 문서는 다시(retry:true = 지금 이전 전부).
//   LLM 실패(503)는 표시하지 않는다. dryRun 도 표시하지 않는다. skippedTried = 이번에 tried 로 건너뛴 수.
//   `exclude`(옛 CLI 의 누적 목록)는 받아서 무시한다.
//   D3: 대상·후보·본문 모두 loadGraph(호출자 권한)로 거른 그래프에서만 — 못 보는 문서는 프롬프트에 실리지 않는다.
//   후보는 TF-IDF 유사도 상위 ≤60(모자라면 제목순 채움) — 전체 문서를 다 싣지 않는다.
//   재시도(retryBefore/retry)는 LLM 응답 캐시를 읽지도 쓰지도 않는다(cache:false).
//   한 문서당 LLM 호출 1번(순차). 큰 limit 은 HTTP 타임아웃에 걸리므로 CLI 가 나눠 부른다.
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const parsed = await readBody(request, bodySchema);
  if (!parsed.ok) return parsed.res;
  const limit = Math.min(20, Math.max(1, Math.floor(parsed.data.limit ?? 5)));
  const dryRun = parsed.data.dryRun === true;
  const retryBefore = parsed.data.retryBefore ? new Date(parsed.data.retryBefore) : parsed.data.retry === true ? new Date() : null;

  const idx = await loadAccess(guard);
  const g = await loadGraph(guard, idx);
  const docs = g.nodes.filter((n) => n.type === "doc");
  const weak = weakDocs(g);
  const triedRows = weak.length
    ? await prisma.page.findMany({ where: { workspaceId, id: { in: weak.map((d) => d.id) }, inferTriedAt: { not: null } }, select: { id: true, inferTriedAt: true } })
    : [];
  const tried = new Map(triedRows.map((r) => [r.id, r.inferTriedAt as Date] as const));
  const { batch, remaining } = selectInferTargets(weak, tried, { retryBefore, limit });
  const skippedTried = [...tried.values()].filter((at) => !retryBefore || at >= retryBefore).length;
  // 본문은 한 번에 — 대상 본문 + 후보 사전 순위(TF-IDF)용. 볼 수 있는 문서(그래프 doc 노드)만 색인한다.
  const rows = batch.length
    ? await prisma.page.findMany({ where: { workspaceId, id: { in: docs.map((d) => d.id) } }, select: { id: true, markdown: true } })
    : [];
  const bodies = new Map(visibleOnly(idx, rows).map((p) => [p.id, p.markdown ?? ""]));
  const titleOf = new Map(docs.map((d) => [d.id, d.title]));
  const vindex = batch.length ? buildIndex(docs.map((d) => ({ id: d.id, title: d.title, text: bodies.get(d.id) ?? "" }))) : null;

  const processed: { id: string; title: string; related: { id: string; title: string; reason: string }[] }[] = [];
  for (const t of batch) {
    const candidates = rankCandidates(vindex!, t.id, docs);
    const raw = await complete(buildRelatedPrompt({ title: t.title, body: bodies.get(t.id) ?? "" }, candidates), {
      feature: "graph-infer",
      workspaceId,
      // 재시도는 새 답이 필요하다 — 같은 프롬프트의 캐시된 답을 돌려주면 재시도가 아무것도 안 바꾼다
      cache: retryBefore ? false : undefined,
    });
    if (raw === null) {
      return NextResponse.json({ ok: false, error: "LLM 미설정/실패. ASK_LLM_PROVIDER(api|cli) 또는 키를 확인하세요.", processed }, { status: 503 });
    }
    const picks = parseRelated(raw, new Set(candidates.map((c) => c.id)));
    if (!dryRun) {
      for (const p of picks) {
        await prisma.graphEdge.upsert({
          where: { fromId_toId_kind: { fromId: t.id, toId: p.id, kind: "related" } },
          create: { workspaceId, fromId: t.id, toId: p.id, kind: "related", tag: "모호", reason: p.reason, model: resolveProvider() },
          update: { reason: p.reason, model: resolveProvider() },
        });
      }
      // 문서마다 비운다 — 중간에 LLM 이 실패(503)해도 이미 저장한 간선은 곧바로 보이게
      if (picks.length) invalidateGraphCache(workspaceId);
    }
    // updatedAt(@updatedAt) 을 건드리면 문서 목록 최신순·검색·컨텍스트가 흔들린다 — raw SQL 로 inferTriedAt 만 쓴다
    if (!dryRun) await prisma.$executeRaw`UPDATE "Page" SET "inferTriedAt" = NOW() WHERE "id" = ${t.id} AND "workspaceId" = ${workspaceId}`;
    processed.push({ id: t.id, title: t.title, related: picks.map((p) => ({ ...p, title: titleOf.get(p.id) ?? p.id })) });
  }
  return NextResponse.json({ ok: true, processed, remaining, skippedTried });
}

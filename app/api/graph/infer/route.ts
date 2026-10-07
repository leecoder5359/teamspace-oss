import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { invalidateGraphCache, loadGraph } from "@/lib/graphLoad";
import { weakDocs } from "@/lib/graphInsights";
import { complete, resolveProvider } from "@/lib/llm";
import { buildRelatedPrompt, parseRelated, rankCandidates } from "@/lib/graphInfer";
import { buildIndex } from "@/lib/vector";

export const runtime = "nodejs";

// POST /api/graph/infer { limit?=5 (≤20), dryRun?, exclude?: string[] (≤5000, 이미 시도한 문서 id) }
//   결정적 근거(링크·id·제목 언급·폴더·짝)가 하나도 없는 문서에 LLM 이 연관 문서 ≤3 을 고른다 → GraphEdge(related, 모호).
//   → { ok, processed:[{id,title,related:[{id,title,reason}]}], remaining }
//   D3: 대상·후보·본문 모두 loadGraph(호출자 권한)로 거른 그래프에서만 — 못 보는 문서는 프롬프트에 실리지 않는다.
//   후보는 TF-IDF 유사도 상위 ≤60(모자라면 제목순 채움) — 전체 문서를 다 싣지 않는다.
//   한 문서당 LLM 호출 1번(순차). 큰 limit 은 HTTP 타임아웃에 걸리므로 CLI 가 나눠 부른다.
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { limit?: number; dryRun?: boolean; exclude?: unknown };
  const limit = Math.min(20, Math.max(1, Number(body.limit ?? 5) || 5));
  const dryRun = body.dryRun === true;
  if (Array.isArray(body.exclude) && body.exclude.length > 5000) {
    return NextResponse.json({ ok: false, error: "exclude 는 최대 5000개" }, { status: 400 });
  }
  const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.filter((x): x is string => typeof x === "string") : []);

  const idx = await loadAccess(guard);
  const g = await loadGraph(guard, idx);
  const docs = g.nodes.filter((n) => n.type === "doc");
  const targets = weakDocs(g).filter((d) => !exclude.has(d.id));
  const batch = targets.slice(0, limit);
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
    const raw = await complete(buildRelatedPrompt({ title: t.title, body: bodies.get(t.id) ?? "" }, candidates));
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
    processed.push({ id: t.id, title: t.title, related: picks.map((p) => ({ ...p, title: titleOf.get(p.id) ?? p.id })) });
  }
  return NextResponse.json({ ok: true, processed, remaining: Math.max(0, targets.length - batch.length) });
}

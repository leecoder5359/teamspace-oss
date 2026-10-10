/* =====================================================================
   LLM 응답 캐시(A-5) — 같은 프롬프트(프로바이더·모델·system 포함)는 다시 부르지 않는다.

   - 키는 sha256(provider\0model\0system\0prompt[\0workspaceId]). 워크스페이스를 아는 호출은 id 가 키에 섞여
     다른 워크스페이스의 응답을 받지 않는다(모르면 구 키와 같다). 프롬프트 본문은 저장하지 않는다.
   - 값은 응답 텍스트와 실제 응답 모델만.
   - 어떤 DB 실패도 호출측으로 새지 않는다(get 실패 = miss, put 실패 = 무시).
   - LLM_CACHE=off 면 lib/llm.ts 가 이 모듈을 건너뛴다.
   - 마지막 적중(lastHitAt) 이 30일 지난 행은 워커가 지운다.
   ===================================================================== */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

export const LLM_CACHE_RETENTION_DAYS = 30;

export function cacheKey(parts: { provider: string; model: string; system?: string; prompt: string; workspaceId?: string | null }): string {
  const segs = [parts.provider, parts.model, parts.system ?? "", parts.prompt];
  if (parts.workspaceId) segs.push(`ws:${parts.workspaceId}`);
  return createHash("sha256")
    .update(segs.join("\0"))
    .digest("hex");
}

export function cacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LLM_CACHE || "").trim().toLowerCase() !== "off";
}

/** hit 면 텍스트·모델, 아니면 null. hit 의 lastHitAt 갱신은 기다리지 않는다. */
export async function getCached(key: string): Promise<{ text: string; model: string } | null> {
  try {
    const row = await prisma.llmCache.findUnique({ where: { key }, select: { text: true, model: true } });
    if (!row) return null;
    void prisma.llmCache.update({ where: { key }, data: { lastHitAt: new Date() } }).then(
      () => undefined,
      () => undefined,
    );
    return { text: row.text, model: row.model };
  } catch {
    return null;
  }
}

/** upsert. 실패는 무시한다. */
export async function putCached(r: { key: string; feature: string; model: string; text: string; workspaceId?: string | null }): Promise<void> {
  try {
    const feature = (r.feature || "other").slice(0, 64);
    const model = (r.model || "unknown").slice(0, 128);
    const now = new Date();
    await prisma.llmCache.upsert({
      where: { key: r.key },
      create: { key: r.key, workspaceId: r.workspaceId ?? null, feature, model, text: r.text },
      update: { feature, model, text: r.text, lastHitAt: now },
    });
  } catch {
    /* 캐시는 최적화일 뿐 — 실패해도 호출 결과는 그대로 */
  }
}

/** 마지막 적중이 보존 기간 지난 행 삭제(워커 주기). */
export async function purgeOldLlmCache(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LLM_CACHE_RETENTION_DAYS * 86_400_000);
  const r = await prisma.llmCache.deleteMany({ where: { lastHitAt: { lt: cutoff } } });
  return r.count;
}

/**
 * 워크스페이스가 쓴 캐시 행 삭제(워크스페이스 삭제 경로용).
 * 워크스페이스를 지우는 API 라우트가 아직 없어(app/api/workspaces 에 DELETE 없음) 호출처가 없다 — 삭제 경로가 생기면 거기서 부른다.
 * 그때까지는 마지막 적중 30일 정리(purgeOldLlmCache)가 안전망이다.
 *
 * 한 번짜리 miss: workspaceId 를 키에 섞기 전(구 키)에 저장된 행은 새 키와 달라 한 번은 miss 가 된다.
 * 새 키로 다시 채워지고 구 행은 30일 정리로 사라진다 — 의도된 비용이다.
 */
export async function deleteLlmCacheForWorkspace(workspaceId: string): Promise<number> {
  const r = await prisma.llmCache.deleteMany({ where: { workspaceId } });
  return r.count;
}

/* =====================================================================
   레슨 주입 기록(LessonInjection)·전문 조회 기록(LessonRead) — 기록·정리.

   /api/context 가 세션 훅 주입(compact·brief)마다 recordLessonInjection 을,
   GET /api/lessons/<id> 가 에이전트 조회마다 recordLessonRead 를 부른다.
   둘 다 fire-and-forget 이고 어떤 실패도 호출측으로 새지 않는다 — 기록 때문에
   세션 컨텍스트가 깨지면 안 된다. 레슨 본문은 받지도 않는다(id·글자 수만).
   ===================================================================== */

import { prisma } from "@/lib/prisma";
import { lessonApplicability, type LessonRenderReport } from "@/lib/lessonInject";

export const LESSON_LOG_RETENTION_DAYS = 90;

const VIA = new Set(["SessionStart", "PostToolUse"]);
/** 훅이 보낸 via 를 정규화 — 모르는 값·없음은 unknown. */
export function normalizeVia(raw: string | null | undefined): string {
  return raw && VIA.has(raw) ? raw : "unknown";
}

/** 렌더 보고서 → 기록할 id 묶음. not_applicable 은 남기지 않는다(이 세션 대상이 아니므로). */
export function injectionIds(report: { statuses: (Pick<LessonRenderReport["statuses"][number], "id" | "status"> & Partial<LessonRenderReport["statuses"][number]>)[] }): { gistIds: string[]; titleIds: string[]; omittedIds: string[] } {
  const by = (s: string) => report.statuses.filter((x) => x.status === s).map((x) => x.id);
  return { gistIds: by("gist"), titleIds: by("title"), omittedIds: by("omitted") };
}

/** brief 모드(lib/contextBrief) 출력에서 id 묶음을 읽는다 — brief 는 요약 없이 제목+id 만 쓰므로
    출력에 보인 id = 제목만, 대상이지만 안 보인 것(전역은 개수만, 넘친 건 '외 N개') = 잘림.
    대상 판정은 compact·brief 와 같은 lessonApplicability — 다른 사람의 개인 레슨·ondemand 는 기록하지 않는다. */
export function briefInjectionIds(
  markdown: string,
  lessons: { id: string; projectId: string | null; stack?: string | null; userId?: string | null; mode?: string | null }[],
  projectId: string | null,
  projectStack: string[],
  personId: string | null = null,
): { gistIds: string[]; titleIds: string[]; omittedIds: string[] } {
  const scope = { projectId, projectStack: projectId ? projectStack : [], personId };
  const eligible = lessons.filter((l) => lessonApplicability(l, scope) === null);
  const titleIds: string[] = [];
  const omittedIds: string[] = [];
  for (const l of eligible) (markdown.includes(`\`${l.id}\``) ? titleIds : omittedIds).push(l.id);
  return { gistIds: [], titleIds, omittedIds };
}

export type LessonInjectionRecord = {
  workspaceId: string;
  actorName?: string | null;
  cwd?: string | null;
  projectId?: string | null;
  via?: string | null;
  mode: "compact" | "brief";
  ids: { gistIds: string[]; titleIds: string[]; omittedIds: string[] };
  chars: number;
};

/** 1행 기록. 기다리지 않아도 되고, 기다려도 throw 하지 않는다. LESSON_INJECTION_LOG=off 면 기록 안 함. */
export function recordLessonInjection(r: LessonInjectionRecord): Promise<void> {
  if ((process.env.LESSON_INJECTION_LOG || "").trim().toLowerCase() === "off") return Promise.resolve();
  try {
    return prisma.lessonInjection
      .create({
        data: {
          workspaceId: r.workspaceId,
          actorName: r.actorName ? r.actorName.slice(0, 128) : null,
          cwd: r.cwd ? r.cwd.slice(0, 1024) : null,
          projectId: r.projectId ?? null,
          via: normalizeVia(r.via),
          mode: r.mode,
          gistIds: r.ids.gistIds,
          titleIds: r.ids.titleIds,
          omittedIds: r.ids.omittedIds,
          chars: Math.max(0, Math.round(r.chars)),
        },
      })
      .then(
        () => maybePurge(),
        () => undefined,
      );
  } catch {
    return Promise.resolve();
  }
}

export function recordLessonRead(r: { workspaceId: string; lessonId: string; actorName?: string | null }): Promise<void> {
  if ((process.env.LESSON_INJECTION_LOG || "").trim().toLowerCase() === "off") return Promise.resolve();
  try {
    return prisma.lessonRead
      .create({ data: { workspaceId: r.workspaceId, lessonId: r.lessonId, actorName: r.actorName ? r.actorName.slice(0, 128) : null } })
      .then(
        () => undefined,
        () => undefined,
      );
  } catch {
    return Promise.resolve();
  }
}

/** 보존 기간 지난 주입·조회 기록 삭제(워커 주기 + 기록·집계 때 기회적으로). */
export async function purgeOldLessonLogs(now = new Date()): Promise<{ injections: number; reads: number }> {
  const cutoff = new Date(now.getTime() - LESSON_LOG_RETENTION_DAYS * 86_400_000);
  const [a, b] = await Promise.all([
    prisma.lessonInjection.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.lessonRead.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  return { injections: a.count, reads: b.count };
}

let lastPurge = 0;
const PURGE_EVERY_MS = 6 * 3600 * 1000;
/** 기회적 정리 — 프로세스당 6시간에 한 번. 실패는 삼킨다. */
export function maybePurge(): Promise<void> {
  if (Date.now() - lastPurge < PURGE_EVERY_MS) return Promise.resolve();
  lastPurge = Date.now();
  return purgeOldLessonLogs().then(
    () => undefined,
    () => undefined,
  );
}

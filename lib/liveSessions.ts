import { prisma } from "@/lib/prisma";
import { loadAccess, pageAccess } from "@/lib/pageGuard";
import { findAssigneeProp, findStatusProp, findTitleProp, optionIdByName, type PropLite } from "@/lib/taskProps";
import { listLocks } from "@/lib/pushLock";
import type { Ctx } from "@/lib/workspace";

/**
 * 라이브 세션 보드(Console 4). 지금 돌고 있는 Claude 세션이 어느 레포·브랜치·워크트리에서
 * 무슨 태스크를 들고 있는지 + 살아 있는 푸시·배포 잠금을 한 번에 본다.
 *
 * '살아 있음' = status active 이고 lastSeenAt 이 2시간 안(한 번도 안 보였으면 시작이 2시간 안).
 * SessionEnd 훅이 못 돈 세션(터미널 강제 종료 등)이 영원히 남지 않게 하는 창이다.
 */
export const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const HEARTBEAT_MIN_INTERVAL_MS = 10 * 60 * 1000;

const cap = (v: unknown, n: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

/** 인입·하트비트 본문의 저장소 필드 정리. 없거나 빈 값은 undefined(기존 값 유지). */
export function sessionGitFields(body: { branch?: unknown; repo?: unknown; worktree?: unknown }) {
  const branch = cap(body.branch, 200);
  const repo = cap(body.repo, 120);
  const worktreePath = cap(body.worktree, 500);
  return {
    ...(branch ? { branch } : {}),
    ...(repo ? { repo } : {}),
    ...(worktreePath ? { worktreePath } : {}),
  };
}

export function liveSessionWhere(workspaceId: string, now: Date) {
  const since = new Date(now.getTime() - LIVE_WINDOW_MS);
  return {
    workspaceId,
    status: "active" as const,
    OR: [{ lastSeenAt: { gte: since } }, { lastSeenAt: null, startedAt: { gte: since } }],
  };
}

/** 워크트리 경로 → 짧은 표시(마지막 폴더 이름). */
export function shortWorktree(p: string | null): string | null {
  if (!p) return null;
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

export type LiveTask = { id: string; title: string; board: string; boardTitle: string };

/**
 * 담당자가 agentNames 중 하나이고 상태가 '진행 중' 인 태스크(내가 볼 수 있는 보드만).
 * 보드마다 담당자·상태 속성 id 가 달라 lib/taskProps 휴리스틱으로 찾는다.
 */
export async function inProgressTasksByAssignee(ctx: Ctx, agentNames: string[]): Promise<Map<string, LiveTask[]>> {
  const out = new Map<string, LiveTask[]>();
  const names = [...new Set(agentNames.filter(Boolean))];
  if (names.length === 0) return out;
  const idx = await loadAccess(ctx);
  const boards = (
    await prisma.page.findMany({
      where: { kind: "database", workspaceId: ctx.workspaceId, deletedAt: null },
      select: { id: true, title: true },
    })
  ).filter((b) => pageAccess(idx, b.id) !== "none");
  if (boards.length === 0) return out;

  const allProps = await prisma.dbProperty.findMany({
    where: { databasePageId: { in: boards.map((b) => b.id) } },
    orderBy: { position: "asc" },
    select: { id: true, name: true, type: true, config: true, databasePageId: true },
  });
  for (const b of boards) {
    const props: PropLite[] = allProps
      .filter((p) => p.databasePageId === b.id)
      .map((p) => ({ id: p.id, name: p.name, type: p.type as string, config: p.config as PropLite["config"] }));
    const assignee = findAssigneeProp(props);
    const status = findStatusProp(props);
    const inProgress = status ? optionIdByName(status, "진행 중") : null;
    if (!assignee || !status || !inProgress) continue;
    const title = findTitleProp(props);
    const rows = await prisma.dbRow.findMany({
      where: { databasePageId: b.id, OR: names.map((n) => ({ props: { path: [assignee.id], equals: n } })) },
      select: { id: true, props: true },
      take: 200,
    });
    for (const r of rows) {
      const p = r.props as Record<string, unknown>;
      if (p[status.id] !== inProgress) continue;
      const who = String(p[assignee.id] ?? "").trim();
      const list = out.get(who) ?? [];
      list.push({ id: r.id, title: (title ? String(p[title.id] ?? "") : "") || "(제목 없음)", board: b.id, boardTitle: b.title });
      out.set(who, list);
    }
  }
  return out;
}

export async function liveBoard(ctx: Ctx, now = new Date()) {
  const sessions = await prisma.claudeSession.findMany({
    where: liveSessionWhere(ctx.workspaceId, now),
    orderBy: [{ lastSeenAt: { sort: "desc", nulls: "last" } }, { startedAt: "desc" }],
    take: 100,
    select: { id: true, externalId: true, repo: true, branch: true, worktreePath: true, cwd: true, project: true, agentName: true, startedAt: true, lastSeenAt: true },
  });
  const tasks = await inProgressTasksByAssignee(ctx, sessions.map((s) => s.agentName ?? ""));
  return {
    windowHours: LIVE_WINDOW_MS / 3600000,
    sessions: sessions.map((s) => ({
      ...s,
      worktree: shortWorktree(s.worktreePath),
      startedAt: s.startedAt.toISOString(),
      lastSeenAt: (s.lastSeenAt ?? s.startedAt).toISOString(),
      tasks: s.agentName ? (tasks.get(s.agentName) ?? []) : [],
    })),
    locks: await listLocks(ctx, null, now),
  };
}

/** 하트비트: 세션 lastSeenAt 갱신. 행이 없으면(시작 인입을 놓친 세션) 만든다. 끝난 것으로 표시된 세션이 다시 뛰면 되살린다(resume). */
export async function heartbeat(ctx: Ctx, body: { sessionId?: unknown; cwd?: unknown; branch?: unknown; repo?: unknown; worktree?: unknown }, now = new Date()) {
  const externalId = cap(body.sessionId, 200);
  if (!externalId) return null;
  const git = sessionGitFields(body);
  const cwd = cap(body.cwd, 1000);
  const row = await prisma.claudeSession.upsert({
    where: { workspaceId_externalId: { workspaceId: ctx.workspaceId, externalId } },
    create: { workspaceId: ctx.workspaceId, externalId, cwd, status: "active", lastSeenAt: now, lastSyncedAt: now, agentName: ctx.actor.name, ...git },
    update: { status: "active", endedAt: null, lastSeenAt: now, lastSyncedAt: now, agentName: ctx.actor.name, ...(cwd ? { cwd } : {}), ...git },
    select: { id: true, lastSeenAt: true },
  });
  return row;
}

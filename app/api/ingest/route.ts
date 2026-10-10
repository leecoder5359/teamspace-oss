import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getDefaultContext, requireCtx } from "@/lib/workspace";
import { verifyHmac, resolveWorkspaceByCwd } from "@/lib/ingest";
import { sessionGitFields } from "@/lib/liveSessions";

export const runtime = "nodejs";

const KINDS = ["observation", "summary", "decision", "commit", "file_change"] as const;
type Kind = (typeof KINDS)[number];

// POST /api/ingest → 세션 훅 인입. 인증 2경로(W3):
//   ① HMAC 서명(x-ingest-signature, agentmemory 등 시크릿 공유 발신자) → cwd 라우트룰로 워크스페이스 해석
//   ② 에이전트 토큰(x-ws-token, wst_/레거시) → 토큰의 워크스페이스 (팀원 머신은 시크릿 배포 없이 참여)
export async function POST(request: Request) {
  const raw = await request.text();
  const sig = request.headers.get("x-ingest-signature") ?? "";
  const secret = (process.env.AUTH_INGEST_SECRET || process.env.AUTH_SECRET || "").trim();

  let workspaceId: string | null = null;
  let agentName: string | null = null;
  if (sig) {
    if (!secret) {
      return NextResponse.json({ error: "AUTH_INGEST_SECRET/AUTH_SECRET 미설정" }, { status: 503 });
    }
    if (!verifyHmac(secret, raw, sig)) {
      return NextResponse.json({ error: "bad signature" }, { status: 401 });
    }
  } else {
    const guard = await requireCtx("editor");
    if ("err" in guard) return guard.err;
    workspaceId = guard.workspaceId;
    agentName = guard.actor.name;
  }

  let body: {
    sessionId?: string;
    cwd?: string;
    project?: string;
    status?: string;
    // 라이브 세션 보드(Console 4) — SessionStart 훅이 보낸다
    branch?: string;
    repo?: string;
    worktree?: string;
    items?: { kind?: string; body?: unknown; externalRef?: string }[];
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const externalId = body.sessionId?.trim();
  if (!externalId) return NextResponse.json({ error: "sessionId 필요" }, { status: 400 });

  // HMAC 경로: cwd → 워크스페이스(라우트룰), 없으면 기본 워크스페이스
  if (!workspaceId) {
    const rules = await prisma.workspaceRouteRule.findMany({
      select: { cwdPrefix: true, workspaceId: true, priority: true },
    });
    workspaceId = resolveWorkspaceByCwd(body.cwd, rules) ?? (await getDefaultContext()).workspaceId;
  }

  const status = body.status === "ended" ? "ended" : "active";
  // 라이브 세션 보드: 저장소 필드(없으면 기존 값 유지)·토큰 이름·마지막 활동
  const live = {
    ...sessionGitFields(body),
    ...(agentName ? { agentName } : {}),
    ...(status === "active" ? { lastSeenAt: new Date() } : {}),
  };
  const session = await prisma.claudeSession.upsert({
    where: { workspaceId_externalId: { workspaceId, externalId } },
    create: {
      workspaceId,
      externalId,
      cwd: body.cwd ?? null,
      project: body.project ?? null,
      status,
      lastSyncedAt: new Date(),
      ...(status === "ended" ? { endedAt: new Date() } : {}),
      ...live,
    },
    update: {
      cwd: body.cwd ?? undefined,
      project: body.project ?? undefined,
      status,
      lastSyncedAt: new Date(),
      ...(status === "ended" ? { endedAt: new Date() } : {}),
      ...live,
    },
    select: { id: true },
  });

  let added = 0;
  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) {
    if (!KINDS.includes(it.kind as Kind)) continue;
    // 멱등성(W8 agent-11): externalRef 가 있으면 같은 세션 내 중복 적재 스킵(리플레이 무해화)
    if (it.externalRef) {
      const dup = await prisma.sessionItem.findFirst({
        where: { sessionId: session.id, externalRef: it.externalRef },
        select: { id: true },
      });
      if (dup) continue;
    }
    await prisma.sessionItem.create({
      data: {
        sessionId: session.id,
        kind: it.kind as Kind,
        body: (it.body ?? {}) as object,
        externalRef: it.externalRef ?? null,
      },
    });
    added++;
  }

  return NextResponse.json({ ok: true, sessionId: session.id, workspaceId, itemsAdded: added });
}

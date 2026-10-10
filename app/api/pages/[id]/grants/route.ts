import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, gatePage, canManageGrants } from "@/lib/pageGuard";
import { recordActivity, pushNotification } from "@/lib/activity";

export const runtime = "nodejs";

/* =====================================================================
   페이지 공유 범위 (격차 D3).

     GET    /api/pages/[id]/grants          → { visibility, grants[], canManage }
     POST   /api/pages/[id]/grants          → { userId|teamId, level } 부여/갱신
     PATCH  /api/pages/[id]/grants          → { visibility: inherit|restricted }
     DELETE /api/pages/[id]/grants?grantId= → 부여 회수

   확정 정책: **편집할 수 있으면 공유 범위도 정한다**(canManageGrants).
   목록 조회는 보기 권한이면 되지만, 바꾸는 건 편집 권한이 필요하다 —
   "누구와 공유돼 있나" 는 그 페이지를 볼 수 있는 사람에게 감출 이유가 없다.
   ===================================================================== */

const GrantBody = z.object({
  userId: z.string().nullable().optional(),
  teamId: z.string().nullable().optional(),
  level: z.enum(["view", "edit"]).optional(),
  // 값 검사는 라우트의 한국어 수동 검사가 맡는다(문구 유지) — 여기선 타입만.
  visibility: z.string().optional(),
});
type Body = { userId?: string | null; teamId?: string | null; level?: "view" | "edit"; visibility?: "inherit" | "restricted" };

async function gate(id: string, min: "view" | "edit") {
  const guard = await requireCtx(min === "edit" ? "editor" : "viewer");
  if ("err" in guard) return { err: guard.err };
  const idx = await loadAccess(guard);
  const g = gatePage(idx, id, min);
  if ("err" in g) return { err: g.err };
  return { guard, idx };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "view");
  if ("err" in g) return g.err;

  const grants = await prisma.pageGrant.findMany({
    where: { pageId: id },
    select: {
      id: true,
      level: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
      team: { select: { id: true, name: true, color: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const page = await prisma.page.findUnique({ where: { id }, select: { visibility: true, title: true } });

  return NextResponse.json({
    visibility: page?.visibility ?? "inherit",
    grants,
    canManage: canManageGrants(g.idx, id),
    // 화면이 "관리자는 볼 수 있습니다" 를 정직하게 표시하도록 정책을 함께 내려준다.
    adminBypass: true,
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "edit");
  if ("err" in g) return g.err;
  const parsedBody = await readBody(req, GrantBody);
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data as Body;
  if (body.visibility !== "inherit" && body.visibility !== "restricted") {
    return NextResponse.json({ error: "visibility 는 inherit 또는 restricted 입니다." }, { status: 400 });
  }

  const page = await prisma.page.update({
    where: { id },
    data: { visibility: body.visibility },
    select: { title: true, visibility: true, createdById: true },
  });

  /* 자기 잠금 방지 — 잠근 사람에게 편집 부여를 자동으로 남긴다.
     실제로 겪은 일: editor 에이전트가 보드를 restricted 로 바꾼 순간 그 보드를
     못 보게 됐다(작성자도 admin 도 아니었으니 판정상 정확하지만, 방금 자기가
     설정한 것을 잃는 건 누가 봐도 사고다). admin 이 풀어 줘야 했다. */
  if (body.visibility === "restricted" && page.createdById !== g.guard.userId && g.guard.role !== "admin") {
    await prisma.pageGrant
      .upsert({
        where: { pageId_userId: { pageId: id, userId: g.guard.userId } },
        create: { pageId: id, userId: g.guard.userId, level: "edit", createdById: g.guard.userId },
        update: { level: "edit" },
      })
      .catch(() => {});
  }
  recordActivity(
    g.guard,
    body.visibility === "restricted" ? "비공개로 전환" : "공개로 전환",
    "page",
    page.title,
    id,
  );
  return NextResponse.json({ ok: true, visibility: page.visibility });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "edit");
  if ("err" in g) return g.err;
  const { workspaceId } = g.guard;
  const parsedBody = await readBody(req, GrantBody);
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data as Body;
  const level = body.level === "edit" ? "edit" : "view";
  const userId = body.userId?.trim() || null;
  const teamId = body.teamId?.trim() || null;

  // 주체는 정확히 하나. 둘 다면 어느 쪽 규칙을 따르는지 알 수 없고, 없으면 아무에게도 안 준다.
  if ((userId && teamId) || (!userId && !teamId)) {
    return NextResponse.json({ error: "userId 또는 teamId 중 하나만 지정하세요." }, { status: 400 });
  }
  // 이 워크스페이스의 활성 멤버·팀만 — 남의 워크스페이스 사람에게 부여할 수 없다.
  if (userId) {
    const member = await prisma.workspaceMember.findFirst({
      where: { workspaceId, userId, status: "active" },
      select: { userId: true },
    });
    if (!member) return NextResponse.json({ error: "이 워크스페이스의 활성 멤버가 아닙니다." }, { status: 400 });
  }
  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: teamId, workspaceId }, select: { id: true } });
    if (!team) return NextResponse.json({ error: "팀을 찾을 수 없습니다." }, { status: 400 });
  }

  const where = userId ? { pageId_userId: { pageId: id, userId } } : { pageId_teamId: { pageId: id, teamId: teamId! } };
  const grant = await prisma.pageGrant.upsert({
    where,
    create: { pageId: id, userId, teamId, level, createdById: g.guard.userId },
    update: { level },
    select: {
      id: true,
      level: true,
      user: { select: { id: true, name: true, email: true } },
      team: { select: { id: true, name: true, color: true } },
    },
  });

  const page = await prisma.page.findUnique({ where: { id }, select: { title: true } });
  recordActivity(g.guard, "공유함", "page", `${page?.title ?? id} → ${grant.user?.name ?? grant.team?.name ?? ""}`, id);
  // 부여받은 사람은 알아야 쓴다 — 조용한 부여는 없는 것과 같다.
  if (userId) {
    void pushNotification(workspaceId, [userId], "shared", `🔓 문서 공유: ${page?.title ?? ""}`, `/p/${id}`, g.guard.userId);
  }
  return NextResponse.json({ ok: true, grant });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "edit");
  if ("err" in g) return g.err;
  const grantId = new URL(req.url).searchParams.get("grantId");
  if (!grantId) return NextResponse.json({ error: "grantId 가 필요합니다." }, { status: 400 });

  const grant = await prisma.pageGrant.findFirst({ where: { id: grantId, pageId: id }, select: { id: true } });
  if (!grant) return NextResponse.json({ error: "부여를 찾을 수 없습니다." }, { status: 404 });
  await prisma.pageGrant.delete({ where: { id: grantId } });

  const page = await prisma.page.findUnique({ where: { id }, select: { title: true } });
  recordActivity(g.guard, "공유 회수", "page", page?.title ?? id, id);
  return NextResponse.json({ ok: true });
}

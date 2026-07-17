import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { withIdempotency } from "@/lib/idempotency";
import { parseMentions } from "@/lib/mention";
import { pushNotification, recordActivity, userIdsByNames } from "@/lib/activity";
import { fireNotif } from "@/lib/notify";

export const runtime = "nodejs";

async function loadPage(id: string, workspaceId: string) {
  const page = await prisma.page.findUnique({
    where: { id },
    select: { id: true, title: true, workspaceId: true, deletedAt: true, projectId: true },
  });
  if (!page || page.workspaceId !== workspaceId || page.deletedAt) return null;
  return page;
}

// GET /api/pages/[id]/comments → 문서 코멘트 목록 (작성자 이름 포함, 오래된 순)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const page = await loadPage(id, guard.workspaceId);
  if (!page) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const comments = await prisma.pageComment.findMany({
    where: { pageId: id },
    orderBy: { createdAt: "asc" },
  });
  const authorIds = [...new Set(comments.map((c) => c.authorId))];
  const users = authorIds.length
    ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? u.email ?? u.id]));
  const isAgent = new Map(users.map((u) => [u.id, (u.email ?? "").endsWith("@agents.teamspace.local")]));
  return NextResponse.json({
    comments: comments.map((c) => ({
      ...c,
      authorName: nameOf.get(c.authorId) ?? "(알 수 없음)",
      authorIsAgent: isAgent.get(c.authorId) ?? false,
    })),
  });
}

// POST /api/pages/[id]/comments { body } → 코멘트 작성. @멘션 → 인앱 알림, comment_added 규칙 발화.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const page = await loadPage(id, guard.workspaceId);
  if (!page) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return withIdempotency(req, guard, async () => {
  const body = (await req.json().catch(() => ({}))) as { body?: string };
  const text = body.body?.trim() ?? "";
  if (!text) return NextResponse.json({ error: "body 가 필요합니다." }, { status: 400 });

  const comment = await prisma.pageComment.create({
    data: { pageId: id, authorId: guard.userId, body: text },
  });

  // @멘션 → 인앱 알림
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: guard.workspaceId, status: "active" },
    select: { user: { select: { name: true } } },
  });
  const names = members.map((m) => m.user.name).filter((n): n is string => !!n);
  const mentioned = parseMentions(text, names);
  if (mentioned.length > 0) {
    const ids = await userIdsByNames(guard.workspaceId, mentioned);
    await pushNotification(
      guard.workspaceId,
      ids,
      "mention",
      `💬 ${guard.actor.name} 이(가) "${page.title}" 코멘트에서 멘션: ${text.slice(0, 80)}`,
      `/docs?open=${id}`,
      guard.userId,
    );
  }

  recordActivity(guard, "commented", "doc", page.title, id);
  void fireNotif(guard.workspaceId, "comment_added", `💬 ${guard.actor.name} → "${page.title}": ${text.slice(0, 100)}`, page.projectId);

  return NextResponse.json({ comment });
  });
}

// DELETE /api/pages/[id]/comments?commentId= → 본인 코멘트 또는 admin 만 삭제
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const page = await loadPage(id, guard.workspaceId);
  if (!page) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const commentId = new URL(req.url).searchParams.get("commentId");
  if (!commentId) return NextResponse.json({ error: "commentId 가 필요합니다." }, { status: 400 });
  const comment = await prisma.pageComment.findUnique({ where: { id: commentId } });
  if (!comment || comment.pageId !== id) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (comment.authorId !== guard.userId && guard.role !== "admin") {
    return NextResponse.json({ error: "본인 코멘트만 삭제할 수 있습니다." }, { status: 403 });
  }
  await prisma.pageComment.delete({ where: { id: commentId } });
  return NextResponse.json({ ok: true });
}

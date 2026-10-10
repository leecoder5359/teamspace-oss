import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage, isRestrictedPage } from "@/lib/pageGuard";
import { locateAnchor } from "@/lib/anchor";
import { readDoc } from "@/lib/docFiles";
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
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;
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

  /* 인라인 코멘트(D2): 저장된 건 인용문+문맥이므로 **지금 본문에서 다시 찾는다**.
     못 찾으면 orphan:true 로 알린다 — 엉뚱한 곳에 붙이느니 "위치를 잃었다" 가 낫다. */
  let markdown = "";
  if (comments.some((c) => c.anchorQuote)) {
    const full = await prisma.page.findUnique({ where: { id }, select: { filePath: true, markdown: true } });
    markdown = full?.markdown ?? "";
    if (full?.filePath) {
      try {
        markdown = (await readDoc(full.filePath)) || markdown;
      } catch {
        /* 파일을 못 읽으면 캐시본으로 — 위치 계산만 덜 정확해진다 */
      }
    }
  }

  return NextResponse.json({
    comments: comments.map((c) => {
      const hit = c.anchorQuote
        ? locateAnchor(markdown, { quote: c.anchorQuote, prefix: c.anchorPrefix ?? "", suffix: c.anchorSuffix ?? "" })
        : null;
      return {
        ...c,
        authorName: nameOf.get(c.authorId) ?? "(알 수 없음)",
        authorIsAgent: isAgent.get(c.authorId) ?? false,
        inline: !!c.anchorQuote,
        orphan: !!c.anchorQuote && !hit,
        range: hit,
      };
    }),
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
  const parsedBody = await readBody(
    req,
    z.object({
      body: z.string().optional(),
      /** 인라인 코멘트(D2): 본문에서 고른 문구와 앞뒤 문맥 */
      anchor: z
        .object({ quote: z.string().optional(), prefix: z.string().optional(), suffix: z.string().optional() })
        .nullable()
        .optional(),
    }),
  );
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data;
  const text = body.body?.trim() ?? "";
  if (!text) return NextResponse.json({ error: "body 가 필요합니다." }, { status: 400 });

  const quote = body.anchor?.quote?.trim();
  const comment = await prisma.pageComment.create({
    data: {
      pageId: id,
      authorId: guard.userId,
      body: text,
      ...(quote
        ? {
            anchorQuote: quote.slice(0, 500),
            anchorPrefix: (body.anchor?.prefix ?? "").slice(-64),
            anchorSuffix: (body.anchor?.suffix ?? "").slice(0, 64),
          }
        : {}),
    },
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
      // `/docs?open=<id>` 는 아무 화면도 파싱하지 않아 알림을 눌러도 문서 목록만 떴다
      // (전수조사 D19). /p/<id> 는 실재하는 문서 라우트다.
      `/p/${id}`,
      guard.userId,
    );
  }

  recordActivity(guard, "commented", "doc", page.title, id);
  // D3 후속: 비공개 문서의 제목·코멘트 본문을 채널로 뿌리지 않는다.
  void isRestrictedPage(id).then((restricted) => {
    if (!restricted) {
      void fireNotif(guard.workspaceId, "comment_added", `💬 ${guard.actor.name} → "${page.title}": ${text.slice(0, 100)}`, page.projectId);
    }
  });

  return NextResponse.json({ comment });
  });
}

// DELETE /api/pages/[id]/comments?commentId= → 본인 코멘트 또는 admin 만 삭제
// PATCH /api/pages/[id]/comments?commentId=... { resolved } → 인라인 코멘트 해결/되돌리기 (격차 D2)
// 지우지 않고 접는다 — 무엇을 왜 고쳤는지가 남아야 리뷰가 의미를 갖는다.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;

  const commentId = new URL(req.url).searchParams.get("commentId");
  if (!commentId) return NextResponse.json({ error: "commentId 가 필요합니다." }, { status: 400 });
  const parsedBody = await readBody(req, z.object({ resolved: z.boolean().optional() }));
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data;

  const comment = await prisma.pageComment.findFirst({ where: { id: commentId, pageId: id }, select: { id: true } });
  if (!comment) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updated = await prisma.pageComment.update({
    where: { id: commentId },
    data: body.resolved
      ? { resolvedAt: new Date(), resolvedById: guard.userId }
      : { resolvedAt: null, resolvedById: null },
  });
  return NextResponse.json({ ok: true, comment: updated });
}

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

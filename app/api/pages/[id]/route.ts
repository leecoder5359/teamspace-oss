import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { checkBaseRev } from "@/lib/concurrency";
import { recordActivity } from "@/lib/activity";
import { fireNotif } from "@/lib/notify";
import { pageFilePath, readContent, writeContent } from "@/lib/content";
import {
  readDoc,
  writeDoc,
  resolveDocPath,
  docFolderFor,
  listDocFolder,
  uniqueFileName,
} from "@/lib/docFiles";

// fs を使うルートは nodejs ランタイム必須
export const runtime = "nodejs";

/**
 * filePath が DOCS_ROOT 内に物理的に存在するかを確認する。
 * resolveDocPath が throw する場合(パス不正 / 非 .md)も false を返す。
 * 既存の content.ts 形式パス ("workspaceId/pageId.md") は
 * DOCS_ROOT 内に存在しないため false になり、新規パスが生成される。
 */
async function isInDocsRoot(filePath: string | null | undefined): Promise<boolean> {
  if (!filePath) return false;
  try {
    const abs = resolveDocPath(filePath);
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

// GET /api/pages/[id] → ページメタ + 本文(markdown)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const page = await prisma.page.findUnique({ where: { id } });
  if (!page || page.workspaceId !== guard.workspaceId || page.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let markdown: string;
  if (page.kind === "doc") {
    // doc: DOCS_ROOT から読み取り (ENOENT → "" → markdown キャッシュにフォールバック)
    markdown = page.filePath
      ? (await readDoc(page.filePath)) || page.markdown || ""
      : page.markdown || "";
  } else {
    // database など: 旧 content.ts 経由 (unchanged)
    markdown = page.filePath
      ? (await readContent(page.filePath)) || page.markdown || ""
      : page.markdown || "";
  }

  return NextResponse.json({
    page: { id: page.id, title: page.title, icon: page.icon, parentId: page.parentId, kind: page.kind, rev: page.rev },
    markdown,
  });
}

// PUT /api/pages/[id] → 本文保存
//   { markdown?, title?, baseRev? } — markdown 이 없으면 본문은 건드리지 않는다(제목만 갱신, 감사 doc-1).
//   baseRev(opt-in)가 서버 rev 와 다르면 409 + 현재 상태 반환(낙관적 잠금, 감사 doc-2/inv-8).
//   본문 저장마다 rev+1 + PageRevision 적재(버전 히스토리, 감사 doc-3).
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as {
    markdown?: string;
    title?: string;
    baseRev?: number;
  };
  const page = await prisma.page.findUnique({ where: { id }, include: { project: true } });
  if (!page || page.workspaceId !== guard.workspaceId || page.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const title = body.title?.trim() || page.title;

  // 본문 유실 가드(doc-1): markdown 미제공 → 제목만 갱신
  if (body.markdown === undefined) {
    if (body.title === undefined) {
      return NextResponse.json({ error: "markdown 또는 title 이 필요합니다." }, { status: 400 });
    }
    await prisma.page.update({ where: { id }, data: { title } });
    return NextResponse.json({ ok: true, rev: page.rev });
  }

  // 낙관적 잠금(opt-in): baseRev 불일치 → 409 + 서버 상태
  const revCheck = checkBaseRev(body.baseRev, page.rev);
  if (!revCheck.ok) {
    return NextResponse.json(
      {
        error: "다른 곳에서 먼저 수정되었습니다. 최신 내용을 확인하고 다시 저장하세요.",
        conflict: true,
        currentRev: revCheck.currentRev,
        currentMarkdown: page.markdown ?? "",
        currentTitle: page.title,
      },
      { status: 409 },
    );
  }

  const markdown = body.markdown;
  const nextRev = page.rev + 1;

  if (page.kind !== "doc") {
    // database など: 旧 content.ts 経由 (unchanged)
    const filePath = page.filePath ?? pageFilePath(page.workspaceId, page.id);
    await writeContent(filePath, markdown, `update: ${title}`);
    await prisma.$transaction([
      prisma.page.update({ where: { id }, data: { markdown, title, filePath, rev: nextRev } }),
      prisma.pageRevision.create({
        data: { pageId: id, rev: nextRev, title, markdown, authorId: guard.userId },
      }),
    ]);
    return NextResponse.json({ ok: true, rev: nextRev });
  }

  // doc: DOCS_ROOT への file-first 書き込み
  let filePath = page.filePath;
  const existsInDocs = await isInDocsRoot(filePath);

  if (!existsInDocs) {
    // 新規 or レガシーパス → 人間可読パスを新規生成
    const folder = docFolderFor(page.project);
    const existing = await listDocFolder(folder);
    const filename = uniqueFileName(existing, title);
    filePath = `${folder}/${filename}`;
  }

  // filePath is guaranteed non-null here (either existing valid docs path or freshly derived)
  await writeDoc(filePath!, markdown);
  await prisma.$transaction([
    prisma.page.update({ where: { id }, data: { markdown, title, filePath, rev: nextRev } }),
    prisma.pageRevision.create({
      data: { pageId: id, rev: nextRev, title, markdown, authorId: guard.userId },
    }),
  ]);

  recordActivity(guard, "updated", "doc", title, id);
  void fireNotif(guard.workspaceId, "doc_saved", `📝 ${guard.actor.name} 문서 저장: ${title}`, page.projectId);
  return NextResponse.json({ ok: true, rev: nextRev });
}

// PATCH /api/pages/[id] → 페이지 메타 변경
//   { projectId?, title?, icon?, parentId? } — 주어진 필드만 갱신.
//   parentId: 폴더 이동(자기 자신/자손으로의 이동은 순환이라 거부).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const page = await prisma.page.findUnique({ where: { id }, select: { id: true, workspaceId: true } });
  if (!page || page.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    projectId?: string | null;
    title?: string;
    icon?: string | null;
    parentId?: string | null;
  };

  const data: { projectId?: string | null; title?: string; icon?: string | null; parentId?: string | null } = {};

  if (body.projectId !== undefined) {
    if (body.projectId !== null) {
      const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { workspaceId: true } });
      if (!project || project.workspaceId !== workspaceId) {
        return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
      }
    }
    data.projectId = body.projectId;
  }

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
    data.title = title;
  }

  if (body.icon !== undefined) {
    data.icon = body.icon;
  }

  if (body.parentId !== undefined) {
    if (body.parentId === id) {
      return NextResponse.json({ error: "자기 자신으로 이동할 수 없습니다." }, { status: 400 });
    }
    if (body.parentId !== null) {
      const parent = await prisma.page.findUnique({ where: { id: body.parentId }, select: { workspaceId: true } });
      if (!parent || parent.workspaceId !== workspaceId) {
        return NextResponse.json({ error: "이동할 위치를 찾을 수 없습니다." }, { status: 400 });
      }
      // 순환 방지: 대상이 이 페이지의 자손이면 거부
      const all = await prisma.page.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, parentId: true },
      });
      const childrenOf = new Map<string, string[]>();
      for (const p of all) {
        if (!p.parentId) continue;
        (childrenOf.get(p.parentId) ?? childrenOf.set(p.parentId, []).get(p.parentId)!).push(p.id);
      }
      const descendants = new Set<string>();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop()!;
        for (const c of childrenOf.get(cur) ?? []) {
          if (!descendants.has(c)) {
            descendants.add(c);
            stack.push(c);
          }
        }
      }
      if (descendants.has(body.parentId)) {
        return NextResponse.json({ error: "하위 항목으로는 이동할 수 없습니다." }, { status: 400 });
      }
    }
    data.parentId = body.parentId;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "변경할 내용이 없습니다." }, { status: 400 });
  }

  await prisma.page.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}

// DELETE /api/pages/[id] → **소프트 삭제**(휴지통, 감사 inv-1). `.md` 파일은 보존.
//   ?recursive=1 이면 서브트리 일괄 — 단일 트랜잭션이라 반쪽 삭제 없음(감사 inv-23).
//   영구 삭제(파일 unlink 포함)는 /api/trash/[id] DELETE 로 분리.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const recursive = new URL(req.url).searchParams.get("recursive") === "1";

  const page = await prisma.page.findUnique({ where: { id }, include: { children: true } });
  if (!page || page.workspaceId !== workspaceId || page.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const liveChildren = page.children.filter((c) => !c.deletedAt);
  if (liveChildren.length > 0 && !recursive) {
    return NextResponse.json({ error: "Has children" }, { status: 409 });
  }

  const now = new Date();
  let ids = [id];
  if (recursive && liveChildren.length > 0) {
    // 서브트리 수집(후위 불필요 — 소프트 삭제는 FK 순서 무관)
    const all = await prisma.page.findMany({
      where: { workspaceId, deletedAt: null },
      select: { id: true, parentId: true },
    });
    const childrenOf = new Map<string, string[]>();
    for (const p of all) {
      if (!p.parentId) continue;
      (childrenOf.get(p.parentId) ?? childrenOf.set(p.parentId, []).get(p.parentId)!).push(p.id);
    }
    const collected = new Set<string>([id]);
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const c of childrenOf.get(cur) ?? []) {
        if (!collected.has(c)) {
          collected.add(c);
          stack.push(c);
        }
      }
    }
    ids = [...collected];
  }

  await prisma.page.updateMany({ where: { id: { in: ids } }, data: { deletedAt: now } });
  recordActivity(guard, "deleted", page.kind === "database" ? "board" : "doc", page.title, id);
  return NextResponse.json({ ok: true, trashed: ids.length });
}

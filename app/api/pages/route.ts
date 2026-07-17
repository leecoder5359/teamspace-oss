import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { withIdempotency } from "@/lib/idempotency";
import { recordActivity } from "@/lib/activity";
import { pageFilePath, writeContent } from "@/lib/content";
import { writeDoc, docFolderFor, listDocFolder, uniqueFileName } from "@/lib/docFiles";

// fs を使うルートは nodejs ランタイム必須
export const runtime = "nodejs";

// GET /api/pages → ワークスペースページ一覧 (ツリー構成用フラット配列)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const pages = await prisma.page.findMany({
    where: { workspaceId, deletedAt: null },
    orderBy: [{ parentId: "asc" }, { position: "asc" }],
    select: { id: true, title: true, icon: true, parentId: true, position: true, kind: true, projectId: true, updatedAt: true },
  });
  return NextResponse.json({ pages });
}

// POST /api/pages → 新規ページ作成
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;
  // 멱등성(W8): Idempotency-Key 재요청 시 저장 응답 반환 — 재시도 이중 생성 방지
  return withIdempotency(request, guard, async () => {
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    parentId?: string | null;
    kind?: string;
    projectId?: string | null;
  };
  const title = body.title?.trim() || "Untitled";
  // kind が明示的に "database" の場合のみ database。それ以外はすべて doc (スキーマデフォルト)
  const kind = body.kind === "database" ? "database" : "doc";

  const last = await prisma.page.findFirst({
    where: { workspaceId, parentId: body.parentId ?? null },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const position = (last?.position ?? -1) + 1;

  const initialMd = `# ${title}\n`;

  if (kind === "database") {
    // database ページ: ファイルなし (unchanged)
    const page = await prisma.page.create({
      data: {
        workspaceId,
        parentId: body.parentId ?? null,
        title,
        position,
        kind: "database",
        projectId: body.projectId ?? null,
        createdById: userId,
        markdown: initialMd,
      },
    });

    // database も旧来どおり content.ts へ書き込み
    const filePath = pageFilePath(workspaceId, page.id);
    await writeContent(filePath, initialMd, `create: ${title}`);
    await prisma.page.update({ where: { id: page.id }, data: { filePath } });

    recordActivity(guard, "created", "doc", page.title, page.id);
    return NextResponse.json({
      page: { id: page.id, title: page.title, parentId: page.parentId, position, kind: page.kind },
    });
  }

  // doc ページ: file-first via docFiles
  // projectId が指定されていればプロジェクト情報を取得してフォルダを決定
  let project: { docsDir: string | null; name: string } | null = null;
  if (body.projectId) {
    project = await prisma.project.findUnique({
      where: { id: body.projectId },
      select: { docsDir: true, name: true },
    });
  }

  const folder = docFolderFor(project);
  const existing = await listDocFolder(folder);
  const filename = uniqueFileName(existing, title);
  const filePath = `${folder}/${filename}`;

  await writeDoc(filePath, initialMd);

  const page = await prisma.page.create({
    data: {
      workspaceId,
      parentId: body.parentId ?? null,
      title,
      position,
      kind: "doc",
      projectId: body.projectId ?? null,
      createdById: userId,
      markdown: initialMd,
      filePath,
    },
  });

  recordActivity(guard, "created", "doc", page.title, page.id);
  return NextResponse.json({
    page: { id: page.id, title: page.title, parentId: page.parentId, position, kind: page.kind },
  });
  });
}

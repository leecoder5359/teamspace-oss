import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { loadAccess, visibleOnly, projectAccess, gatePage } from "@/lib/pageGuard";
import { withIdempotency } from "@/lib/idempotency";
import { recordActivity } from "@/lib/activity";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { pageFilePath, writeContent } from "@/lib/content";
import { DOC_TYPES } from "@/lib/docOrganize";
import { listPagesForSidebar } from "@/lib/pagesList";
import { findSameTitleDocs } from "@/lib/docTitles";
import { TEMPLATES, TEMPLATE_NAMES, renderTemplate } from "@/lib/docTemplates";
import { writeDoc, docFolderFor, listDocFolder, uniqueFileName } from "@/lib/docFiles";

const CreateBody = z.object({
  title: z.string().optional(),
  parentId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  kind: z.enum(["doc", "database"]).optional(),
  docType: z.enum(DOC_TYPES).optional(),
  folder: z.string().trim().min(1).max(80).optional(),
  // 문서 템플릿(F9) — 지정하면 초기 본문이 템플릿이고 docType 기본값도 템플릿 것.
  template: z.enum(TEMPLATE_NAMES).optional(),
  // true 면 같은 프로젝트에 같은 제목 문서가 이미 있을 때 409 로 거절한다(기본은 경고만).
  ifUnique: z.boolean().optional(),
});

// fs を使うルートは nodejs ランタイム必須
export const runtime = "nodejs";

// GET /api/pages → ワークスペースページ一覧 (ツリー構成用フラット配列)
// 본문은 lib/pagesList — (ws) 레이아웃이 첫 페인트용으로 같은 목록을 주입한다(U7).
// ?archived=1 → 보관된 문서만(보관함) · ?archived=all → 둘 다 (F2). 기본은 보관 제외.
export async function GET(request?: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const a = request ? new URL(request.url).searchParams.get("archived") : null;
  const archived = a === "1" ? "only" : a === "all" ? "all" : "active";
  return NextResponse.json({ pages: await listPagesForSidebar(guard, undefined, { archived }) });
}

// POST /api/pages → 新規ページ作成
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;
  // 멱등성(W8): Idempotency-Key 재요청 시 저장 응답 반환 — 재시도 이중 생성 방지
  return withIdempotency(request, guard, async () => {
  const parsed = await readBody(request, CreateBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const title = body.title?.trim() || "Untitled";
  // kind が明示的に "database" の場合のみ database。それ以外はすべて doc (スキーマデフォルト)
  const kind = body.kind === "database" ? "database" : "doc";

  const initialMd = body.template && kind === "doc"
    // 템플릿 날짜는 한국 날짜 — UTC 로 자르면 KST 00:00~08:59 에 만든 문서가 전날로 찍힌다.
    ? renderTemplate(body.template, title, new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }))
    : `# ${title}\n`;
  const docType = body.docType ?? (body.template ? TEMPLATES[body.template].docType : null);

  // 참조 검증 — PATCH(app/api/pages/[id]/route.ts)는 이미 400 으로 거절하는데
  // POST 만 무검증이었다(D6). 남의 워크스페이스 프로젝트를 지정하면 그 프로젝트의
  // docsDir 로 실제 .md 파일이 기록됐다(DOCS_ROOT 는 워크스페이스로 분할되지 않는다).
  const projRef = await resolveProjectRef(body.projectId, workspaceId);
  if (!projRef.ok) return projRef.err;
  const refProjectId = projRef.projectId;

  // D3: 남의 잠긴 프로젝트·잠긴 페이지 아래에 문서를 만들 수 없다.
  // (만들 수 있으면 그 안을 들여다볼 발판이 되고, 목록에도 남는다.)
  const access = await loadAccess(guard);
  if (refProjectId && projectAccess(access, refProjectId) !== "edit") {
    return NextResponse.json({ error: "이 프로젝트에 문서를 만들 권한이 없습니다." }, { status: 403 });
  }

  if (body.parentId) {
    const parent = await prisma.page.findFirst({
      where: { id: body.parentId, workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) {
      return NextResponse.json({ error: "상위 페이지를 찾을 수 없습니다." }, { status: 400 });
    }
    const parentGate = gatePage(access, body.parentId, "edit");
    if ("err" in parentGate) return parentGate.err;
  }

  // 같은 제목 문서 경고(B5) — doc 만. ifUnique 면 거절, 아니면 응답에 warnings 로 알린다.
  // 가시성(D3): 못 보는 문서는 중복으로 치지 않는다(존재·제목 노출 방지). 필터 후 10건으로 자른다.
  const dups =
    kind === "doc"
      ? visibleOnly(access, await findSameTitleDocs(prisma, { workspaceId, projectId: refProjectId, title })).slice(0, 10)
      : [];
  if (body.ifUnique && dups.length > 0) {
    return NextResponse.json({ error: "같은 제목 문서가 이미 있습니다.", duplicates: dups }, { status: 409 });
  }

  const nextPosition = async (parentId: string | null) => {
    const last = await prisma.page.findFirst({
      where: { workspaceId, parentId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    return (last?.position ?? -1) + 1;
  };

  if (kind === "database") {
    // database ページ: ファイルなし (unchanged)
    const position = await nextPosition(body.parentId ?? null);
    const page = await prisma.page.create({
      data: {
        workspaceId,
        parentId: body.parentId ?? null,
        title,
        position,
        kind: "database",
        projectId: refProjectId,
        createdById: userId,
        markdown: initialMd,
      },
    });

    // database も旧来どおり content.ts へ書き込み
    const filePath = pageFilePath(workspaceId, page.id);
    await writeContent(filePath, initialMd, `create: ${title}`);
    await prisma.page.update({ where: { id: page.id }, data: { filePath } });

    invalidateGraphCache(workspaceId);
    recordActivity(guard, "created", "doc", page.title, page.id);
    return NextResponse.json({
      page: { id: page.id, title: page.title, parentId: page.parentId, position, kind: page.kind },
    });
  }

  // doc ページ: file-first via docFiles
  // projectId が指定されていればプロジェクト情報を取得してフォルダを決定
  let project: { docsDir: string | null; name: string } | null = null;
  if (refProjectId) {
    project = await prisma.project.findUnique({
      where: { id: refProjectId },
      select: { docsDir: true, name: true },
    });
  }

  const dir = docFolderFor(project);
  const existing = await listDocFolder(dir);

  // folder: 같은 위치(워크스페이스·프로젝트·최상위)의 같은 제목 폴더 문서를 찾아 부모로 쓰고, 없으면 먼저 만든다.
  let parentId = body.parentId ?? null;
  if (body.folder && !parentId) {
    const folderTitle = body.folder.trim();
    const found = await prisma.page.findFirst({
      where: { workspaceId, projectId: refProjectId, parentId: null, kind: "doc", deletedAt: null, title: folderTitle },
      select: { id: true },
    });
    if (found) {
      const folderGate = gatePage(access, found.id, "edit");
      if ("err" in folderGate) return folderGate.err;
      parentId = found.id;
    } else {
      const folderMd = `# ${folderTitle}\n`;
      const folderFile = uniqueFileName(existing, folderTitle);
      const folderPath = `${dir}/${folderFile}`;
      const folderPage = await prisma.page.create({
        data: {
          workspaceId,
          parentId: null,
          title: folderTitle,
          position: await nextPosition(null),
          kind: "doc",
          projectId: refProjectId,
          createdById: userId,
          markdown: folderMd,
          filePath: folderPath,
        },
      });
      await writeDoc(folderPath, folderMd);
      existing.push(folderFile);
      parentId = folderPage.id;
    }
  }

  const position = await nextPosition(parentId);
  const filename = uniqueFileName(existing, title);
  const filePath = `${dir}/${filename}`;

  // 행을 먼저 만들고 파일을 쓴다 — 순서가 반대였을 땐 create 가 실패해도
  // 이미 쓴 .md 가 고아로 남았다(D6).
  const page = await prisma.page.create({
    data: {
      workspaceId,
      parentId,
      title,
      position,
      kind: "doc",
      docType,
      projectId: refProjectId,
      createdById: userId,
      markdown: initialMd,
      filePath,
    },
  });

  await writeDoc(filePath, initialMd);

  invalidateGraphCache(workspaceId);
  recordActivity(guard, "created", "doc", page.title, page.id);
  return NextResponse.json({
    page: { id: page.id, title: page.title, parentId: page.parentId, position, kind: page.kind },
    ...(dups.length > 0 ? { warnings: [{ code: "duplicate_title", pages: dups }] } : {}),
  });
  });
}

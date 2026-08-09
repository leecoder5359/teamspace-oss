import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly, projectAccess, gatePage } from "@/lib/pageGuard";
import { effectiveRestricted } from "@/lib/pageAccess";
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
    select: { id: true, title: true, icon: true, parentId: true, position: true, kind: true, projectId: true, updatedAt: true, visibility: true },
  });
  // D3: 사이드바·팔레트·검색 후보가 전부 이 목록을 쓴다 — 여기서 새면 제목이 통째로 샌다.
  const idx = await loadAccess(guard);
  const visible = visibleOnly(idx, pages);

  /* D3 후속: 화면에 자물쇠를 그릴 수 있게 '비공개인지'를 함께 준다.
     접근 판정과는 목적이 다르다 — 볼 수 있는 사람에게도 "이건 모두에게 열려
     있지 않다"를 알려야, 잠근 줄 모르고 쓰거나 잠긴 줄 모르고 공유를 기대하는
     일이 없다. `restrictedSelf` 는 잠금이 이 페이지에서 시작됐는지(트리에서
     자손마다 자물쇠를 겹쳐 그리지 않으려고). */
  const projects = await prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, visibility: true },
  });
  const nodes = visible.map((p) => ({
    id: p.id,
    parentId: p.parentId,
    projectId: p.projectId,
    createdById: "",
    visibility: p.visibility,
  }));
  const all = effectiveRestricted(nodes, projects);
  const own = effectiveRestricted(nodes, projects, { ownOnly: true });

  return NextResponse.json({
    pages: visible.map((p) => ({ ...p, restricted: all.has(p.id), restrictedSelf: own.has(p.id) })),
  });
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

  if (kind === "database") {
    // database ページ: ファイルなし (unchanged)
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

  const folder = docFolderFor(project);
  const existing = await listDocFolder(folder);
  const filename = uniqueFileName(existing, title);
  const filePath = `${folder}/${filename}`;

  // 행을 먼저 만들고 파일을 쓴다 — 순서가 반대였을 땐 create 가 실패해도
  // 이미 쓴 .md 가 고아로 남았다(D6).
  const page = await prisma.page.create({
    data: {
      workspaceId,
      parentId: body.parentId ?? null,
      title,
      position,
      kind: "doc",
      projectId: refProjectId,
      createdById: userId,
      markdown: initialMd,
      filePath,
    },
  });

  await writeDoc(filePath, initialMd);

  recordActivity(guard, "created", "doc", page.title, page.id);
  return NextResponse.json({
    page: { id: page.id, title: page.title, parentId: page.parentId, position, kind: page.kind },
  });
  });
}

import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { recordActivity } from "@/lib/activity";
import { readZip } from "@/lib/unzip";
import { planImport, type PlannedDoc } from "@/lib/importPlan";
import { boardRowProps, optionKey } from "@/lib/csvBoard";
import { rewriteHrefs, uploadFileName } from "@/lib/assets";
import { writeDoc, docFolderFor, listDocFolder, uniqueFileName } from "@/lib/docFiles";
import { uploadRoot } from "@/lib/uploadPaths";

export const runtime = "nodejs";

/* =====================================================================
   POST /api/import (multipart) → zip 안의 마크다운을 문서로 가져온다.

   격차조사 E2: E1(내보내기)의 짝이 없었다. 넣을 수 없는 저장소는 옮겨 오는
   비용이 무한대라 "쓰기 시작할 수" 가 없다.

   받는 것: 우리 export zip · 노션 export zip · 그냥 마크다운 폴더 zip.
   판별·정규화는 전부 순수 함수(lib/importPlan)에 있고 여기서는 IO 만 한다.

   **드라이런이 기본이 아닌 대신 1급 시민이다**(`?dryRun=1`). 수십~수백 개
   문서를 만드는 되돌릴 수 없는 작업이라, 무엇이 생기고 무엇이 버려지는지를
   같은 계산으로 먼저 보여준다. 미리보기와 실행이 다른 코드를 타면 미리보기는
   있으나 마나이므로 planImport 하나만 쓴다.

   권한은 E1 과 대칭으로 editor — editor 는 어차피 /api/pages 로 문서를 만들 수
   있다. 벌크라는 사실은 역할이 아니라 활동 로그로 남긴다.
   ===================================================================== */

const MAX_BYTES = 50 * 1024 * 1024; // 압축 상태 기준. 볼트 하나가 이보다 크면 나눠 올린다.
const MAX_DOCS = 2000;
const MAX_BOARD_ROWS = 5000; // 보드 전체 합. CSV 한 개의 상한은 lib/csvBoard 가 본다.

/** select 옵션 색상 — 화면이 아는 키(components/ws/ui.tsx 의 SELECT_COLORS)를 돌려 쓴다. */
const OPTION_COLORS = ["blue", "green", "yellow", "red", "purple", "orange", "pink", "teal", "gray"];

type DocResult = PlannedDoc & {
  /** 같은 프로젝트에 같은 제목의 문서가 이미 있다(재가져오기 감지) */
  duplicate: boolean;
  /** 실제 생성된 경우에만 */
  pageId?: string;
  createdPath?: string;
  skipped?: boolean;
};

type BoardResult = {
  path: string;
  title: string;
  projectName: string | null;
  columns: { name: string; type: string; options: number }[];
  rows: number;
  /** 같은 프로젝트에 같은 제목의 보드가 이미 있다 */
  duplicate: boolean;
  pageId?: string;
  skipped?: boolean;
  /** 행의 본문으로 이어붙인 문서 수(노션 데이터베이스) */
  linkedDocs: number;
};

export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;

  const url = new URL(req.url);

  // 크기는 **본문을 읽기 전에** 본다. 뒤에서 file.size 로도 보지만, 그때는 이미
  // 수백 MB 를 메모리에 올린 뒤다. content-length 를 못 믿는 경우가 있어 둘 다 둔다.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: `zip 이 너무 큽니다(최대 ${MAX_BYTES / 1024 / 1024}MB).` }, { status: 413 });
  }

  let formErr: string | null = null;
  const form = await req.formData().catch((e: unknown) => {
    formErr = (e as Error)?.message ?? String(e);
    return null;
  });
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: `multipart form-data 의 file 필드(zip)가 필요합니다.${formErr ? ` (본문을 읽지 못했습니다: ${formErr})` : ""}` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `zip 이 너무 큽니다(최대 ${MAX_BYTES / 1024 / 1024}MB).` }, { status: 413 });
  }

  const str = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const truthy = (v: string) => v === "1" || v === "true" || v === "on";
  // 드라이런은 쿼리로도 폼 필드로도 받는다 — CLI 는 쿼리, 화면 폼은 필드가 자연스럽다.
  const dryRun = truthy(url.searchParams.get("dryRun") ?? "") || truthy(str("dryRun"));
  const createProjects = truthy(str("createProjects"));
  const skipExisting = truthy(str("skipExisting"));

  // 강제 프로젝트: 주면 zip 안의 폴더 구조와 무관하게 전부 이 프로젝트로 간다.
  const forced = await resolveProjectRef(str("projectId") || null, workspaceId);
  if (!forced.ok) return forced.err;
  const forcedProjectId = forced.projectId;

  // D3: 남의 잠긴 프로젝트에 문서를 밀어 넣을 수 없다.
  const access = await loadAccess(guard);
  if (forcedProjectId && projectAccess(access, forcedProjectId) !== "edit") {
    return NextResponse.json({ error: "이 프로젝트에 문서를 만들 권한이 없습니다." }, { status: 403 });
  }

  /* ── zip 풀기 ── */
  let entries;
  try {
    entries = readZip(Buffer.from(await file.arrayBuffer()));
  } catch (e) {
    return NextResponse.json({ error: `zip 을 읽을 수 없습니다: ${(e as Error).message}` }, { status: 400 });
  }

  const plan = planImport(entries.map((e) => ({ path: e.path, text: e.data.toString("utf8") })));
  if (plan.documents.length > MAX_DOCS) {
    return NextResponse.json(
      { error: `한 번에 가져올 수 있는 문서는 ${MAX_DOCS}개입니다(${plan.documents.length}개).` },
      { status: 413 },
    );
  }
  const totalRows = plan.boards.reduce((n, b) => n + b.rows.length, 0);
  if (totalRows > MAX_BOARD_ROWS) {
    return NextResponse.json(
      { error: `한 번에 가져올 수 있는 보드 행은 ${MAX_BOARD_ROWS}개입니다(${totalRows}개).` },
      { status: 413 },
    );
  }

  /* ── 프로젝트 이름 → id 해석 ──
     이름이 같은 기존 프로젝트에 붙인다. 없으면 createProjects 일 때만 만들고,
     아니면 미분류로 둔다(조용히 만들지 않는다 — 프로젝트는 화면의 1급 구조다). */
  const existingProjects = await prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true, docsDir: true },
  });
  const byName = new Map(existingProjects.map((p) => [p.name.toLowerCase(), p]));

  const projectPlan = plan.projects.map((name) => {
    const hit = byName.get(name.toLowerCase());
    return {
      name,
      projectId: forcedProjectId ?? hit?.id ?? null,
      willCreate: !forcedProjectId && !hit && createProjects,
      matched: !!hit,
    };
  });

  /* ── 재가져오기 감지: 같은 (프로젝트, 제목) 문서가 이미 있나 ── */
  const existingDocs = await prisma.page.findMany({
    where: { workspaceId, kind: "doc", deletedAt: null },
    select: { title: true, projectId: true },
  });
  const dupKey = (projectId: string | null, title: string) => `${projectId ?? ""}::${title.toLowerCase()}`;
  const existingKeys = new Set(existingDocs.map((d) => dupKey(d.projectId, d.title)));

  const existingBoards = await prisma.page.findMany({
    where: { workspaceId, kind: "database", deletedAt: null },
    select: { title: true, projectId: true },
  });
  const existingBoardKeys = new Set(existingBoards.map((b) => dupKey(b.projectId, b.title)));

  const resolveProjectId = (name: string | null): string | null => {
    if (forcedProjectId) return forcedProjectId;
    if (!name) return null;
    return projectPlan.find((p) => p.name === name)?.projectId ?? null;
  };

  const results: DocResult[] = plan.documents.map((d) => ({
    ...d,
    duplicate: existingKeys.has(dupKey(resolveProjectId(d.projectName), d.title)),
  }));

  const boardResults: BoardResult[] = plan.boards.map((b) => ({
    path: b.path,
    title: b.title,
    projectName: b.projectName,
    columns: b.columns.map((c) => ({ name: c.name, type: c.type, options: c.options.length })),
    rows: b.rows.length,
    duplicate: existingBoardKeys.has(dupKey(resolveProjectId(b.projectName), b.title)),
    linkedDocs: b.rows.filter((r) => r.contentDocPath).length,
  }));

  // 첨부(E4): zip 안의 파일 → 버퍼. 문서가 실제로 참조한 것만 계획에 들어 있다.
  // plan.assets 는 공통 루트를 벗긴 경로라 원래 zip 경로로 되돌려 찾는다.
  const byPath = new Map(entries.map((e) => [e.path.replace(/\\/g, "/"), e.data]));
  const relToZip = new Map<string, Buffer>();
  for (const a of plan.assets) {
    const buf = byPath.get(plan.root ? `${plan.root}/${a}` : a);
    if (buf) relToZip.set(a, buf);
  }
  const assetBytes = [...relToZip.values()].reduce((n, b) => n + b.length, 0);

  const summary = {
    ok: true,
    dryRun,
    format: plan.format,
    projects: projectPlan,
    skipped: plan.skipped,
    warnings: plan.warnings,
    counts: {
      documents: results.length,
      duplicates: results.filter((r) => r.duplicate).length,
      skippedFiles: plan.skipped.length,
      projectsToCreate: projectPlan.filter((p) => p.willCreate).length,
      attachments: relToZip.size,
      attachmentBytes: assetBytes,
      folders: plan.folders.length,
      boards: boardResults.length,
      boardRows: totalRows,
      boardDuplicates: boardResults.filter((b) => b.duplicate).length,
    },
  };

  if (dryRun) {
    return NextResponse.json({
      ...summary,
      folders: plan.folders.map((f) => ({
        path: f.path,
        name: f.name,
        projectName: f.projectName,
        reusesDoc: !!f.docPath,
        reusesBoard: !!f.boardPath,
      })),
      boards: boardResults.map((b) => ({ ...b, projectId: resolveProjectId(b.projectName) })),
      attachments: [...relToZip].map(([p, b]) => ({ path: p, bytes: b.length })),
      documents: results.map((r) => ({
        path: r.path,
        title: r.title,
        project: r.projectName,
        projectId: resolveProjectId(r.projectName),
        duplicate: r.duplicate,
        attachments: r.assets.length,
        bytes: Buffer.byteLength(r.markdown, "utf8"),
      })),
    });
  }

  /* ── 여기서부터 실제 생성 ── */
  const projectById = new Map(existingProjects.map((p) => [p.id, p]));
  for (const p of projectPlan) {
    if (!p.willCreate) continue;
    const last = await prisma.project.findFirst({
      where: { workspaceId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const created = await prisma.project.create({
      data: { workspaceId, name: p.name, position: (last?.position ?? -1) + 1 },
      select: { id: true, name: true, docsDir: true },
    });
    p.projectId = created.id;
    byName.set(created.name.toLowerCase(), created);
    projectById.set(created.id, created);
  }

  // 페이지 position 은 루트(parentId=null) 기준으로 이어 붙인다.
  const lastPage = await prisma.page.findFirst({
    where: { workspaceId, parentId: null },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  let position = (lastPage?.position ?? -1) + 1;

  /* ── 첨부 복원(E4) ──
     문서를 만들기 전에 파일부터 놓는다. 반대 순서면 본문이 아직 없는 그림을
     가리키는 순간이 생긴다. 이름은 /api/upload 와 같은 규칙(내용 해시 접두)이라
     같은 그림을 두 번 가져와도 파일이 늘지 않는다. */
  const uploadDir = path.join(uploadRoot(), workspaceId);
  if (relToZip.size > 0) await fs.mkdir(uploadDir, { recursive: true });
  const assetUrl = new Map<string, string>(); // plan 기준 경로 → 새 URL
  for (const [rel, buf] of relToZip) {
    const name = uploadFileName(rel, createHash("sha256").update(buf).digest("hex"));
    await fs.writeFile(path.join(uploadDir, name), buf);
    assetUrl.set(rel, `/uploads/${workspaceId}/${encodeURIComponent(name)}`);
  }

  // 같은 폴더에 여러 건을 쓰므로 파일명 목록을 폴더당 한 번만 읽고 누적한다
  // (문서마다 readdir 하면 N번 읽는데다, 방금 쓴 파일이 아직 안 보이는 경합도 생긴다).
  const folderFiles = new Map<string, string[]>();
  let createdCount = 0;

  for (const r of results) {
    if (skipExisting && r.duplicate) {
      r.skipped = true;
      continue;
    }
    const projectId = resolveProjectId(r.projectName);
    const folder = docFolderFor(projectId ? (projectById.get(projectId) ?? null) : null);
    if (!folderFiles.has(folder)) folderFiles.set(folder, await listDocFolder(folder));
    const names = folderFiles.get(folder)!;
    const filename = uniqueFileName(names, r.title);
    names.push(filename);
    const filePath = `${folder}/${filename}`;

    // 본문의 첨부 목적지를 방금 복원한 업로드 URL 로 갈아끼운다.
    const hrefMap: Record<string, string> = {};
    for (const a of r.assets) {
      const url = assetUrl.get(a.zipPath);
      if (url) hrefMap[a.href] = url;
    }
    const markdown = Object.keys(hrefMap).length ? rewriteHrefs(r.markdown, hrefMap) : r.markdown;

    // 행을 먼저 만들고 파일을 쓴다 — 반대면 create 실패 시 고아 .md 가 남는다(pages POST 와 같은 순서).
    const page = await prisma.page.create({
      data: {
        workspaceId,
        parentId: null,
        title: r.title,
        position: position++,
        kind: "doc",
        projectId,
        createdById: userId,
        markdown,
        filePath,
      },
      select: { id: true },
    });
    await writeDoc(filePath, markdown);
    r.pageId = page.id;
    r.createdPath = filePath;
    createdCount++;
  }

  /* ── 보드(CSV) 만들기 (E2 후속) ──
     문서를 먼저 다 만든 뒤에 온다 — 노션 데이터베이스는 행마다 md 를 따로
     내보내므로, 그 문서들이 있어야 행의 본문(contentPageId)으로 이어붙일 수 있다.
     보드는 별도 테이블이 아니라 `kind:"database"` 페이지 + 속성 + 행이다. */
  const boardPageId = new Map<string, string>(); // csv 의 zip 경로 → 만든 보드 pageId
  const docByZipPath = new Map(results.filter((r) => r.pageId).map((r) => [r.path, r.pageId!]));
  let boardCount = 0;
  let boardRowCount = 0;

  for (const b of plan.boards) {
    const br = boardResults.find((x) => x.path === b.path)!;
    if (skipExisting && br.duplicate) {
      br.skipped = true;
      continue;
    }
    const projectId = resolveProjectId(b.projectName);
    const page = await prisma.page.create({
      data: {
        workspaceId,
        parentId: null,
        title: b.title,
        position: position++,
        kind: "database",
        projectId,
        createdById: userId,
      },
      select: { id: true },
    });

    // 속성: 열 순서 그대로. select 옵션 id 는 여기서 만들고, 행 값은 그 id 를 쓴다
    // (이름을 그대로 넣으면 화면·필터가 옵션을 못 찾는다 — lib/csvBoard 의 boardRowProps 참조).
    const propIds: string[] = [];
    const optionIds: Record<string, string> = {};
    let firstSelect: string | null = null;
    for (const [i, col] of b.columns.entries()) {
      const options = col.options.map((name, k) => ({
        id: crypto.randomUUID(),
        name,
        color: OPTION_COLORS[k % OPTION_COLORS.length],
      }));
      const prop = await prisma.dbProperty.create({
        data: {
          databasePageId: page.id,
          name: col.name,
          type: col.type,
          position: i,
          config: col.type === "select" ? { options } : {},
        },
        select: { id: true },
      });
      propIds.push(prop.id);
      for (const o of options) optionIds[optionKey(i, o.name)] = o.id;
      if (col.type === "select" && !firstSelect) firstSelect = prop.id;
    }

    // 뷰: 표는 항상, 칸반은 select 열이 있을 때만(그룹 기준이 없으면 빈 화면이 된다).
    await prisma.dbView.create({ data: { databasePageId: page.id, name: "표", type: "table", position: 0 } });
    if (firstSelect) {
      await prisma.dbView.create({
        data: { databasePageId: page.id, name: "보드", type: "kanban", position: 1, config: { groupBy: firstSelect } },
      });
    }

    const rowProps = boardRowProps(b, propIds, optionIds);
    if (rowProps.length > 0) {
      await prisma.dbRow.createMany({
        data: rowProps.map((props, i) => ({
          databasePageId: page.id,
          props: props as object,
          position: i,
          createdById: userId,
          updatedById: userId,
          // 노션 행 문서를 그 행의 본문으로. 문서가 안 만들어졌으면(중복 건너뜀) null.
          contentPageId: b.rows[i].contentDocPath ? (docByZipPath.get(b.rows[i].contentDocPath!) ?? null) : null,
        })),
      });
    }
    boardPageId.set(b.path, page.id);
    br.pageId = page.id;
    boardCount++;
    boardRowCount += rowProps.length;
  }

  /* ── 문서 계층 복원 (E2 후속) ──
     폴더는 별도 타입이 아니라 **자식을 가진 doc 페이지**다. 문서를 먼저 다 만들고
     여기서 부모를 이어 붙이는 이유는 순서 문제를 없애기 위해서다 — 폴더 자리에
     이미 문서가 있는 경우(노션의 `스펙.md` + `스펙/`)까지 한 번에 풀린다. */
  const folderPageId = new Map<string, string>(); // `${project}\u0000${path}` → pageId
  let folderCount = 0;

  for (const f of plan.folders) {
    const key = `${f.projectName ?? ""}\u0000${f.path}`;
    // 폴더 자리에 문서·보드가 있으면 그걸 부모로 쓴다(빈 폴더를 만들면 둘로 갈라진다).
    // 노션 데이터베이스가 정확히 이 경우다: `Tasks.csv` + `Tasks/행.md`.
    const existing = (f.boardPath ? boardPageId.get(f.boardPath) : undefined) ?? (f.docPath ? docByZipPath.get(f.docPath) : undefined);
    if (existing) {
      folderPageId.set(key, existing);
      continue;
    }
    const projectId = resolveProjectId(f.projectName);
    const folder = docFolderFor(projectId ? (projectById.get(projectId) ?? null) : null);
    if (!folderFiles.has(folder)) folderFiles.set(folder, await listDocFolder(folder));
    const names = folderFiles.get(folder)!;
    const filename = uniqueFileName(names, f.name);
    names.push(filename);
    const filePath = `${folder}/${filename}`;
    const md = `# ${f.name}\n`;
    const created = await prisma.page.create({
      data: {
        workspaceId,
        parentId: null,
        title: f.name,
        position: position++,
        kind: "doc",
        projectId,
        createdById: userId,
        markdown: md,
        filePath,
      },
      select: { id: true },
    });
    await writeDoc(filePath, md);
    folderPageId.set(key, created.id);
    folderCount++;
  }

  // 부모 배선: 폴더 → 상위 폴더, 문서 → 자기 폴더.
  const linkTo = async (pageId: string, projectName: string | null, path: string | null) => {
    if (!path) return;
    const parent = folderPageId.get(`${projectName ?? ""}\u0000${path}`);
    if (parent && parent !== pageId) {
      await prisma.page.update({ where: { id: pageId }, data: { parentId: parent } }).catch(() => {});
    }
  };
  for (const f of plan.folders) {
    const id = folderPageId.get(`${f.projectName ?? ""}\u0000${f.path}`);
    if (id) await linkTo(id, f.projectName, f.parentPath);
  }
  for (const r of results) {
    if (r.pageId) await linkTo(r.pageId, r.projectName, r.folderPath);
  }
  for (const b of plan.boards) {
    const id = boardPageId.get(b.path);
    if (id) await linkTo(id, b.projectName, b.folderPath ?? null);
  }

  recordActivity(
    guard,
    "가져옴",
    "workspace",
    `${file.name} (${plan.format} · 문서 ${createdCount}건${boardCount ? ` · 보드 ${boardCount}(행 ${boardRowCount})` : ""}${assetUrl.size ? ` · 첨부 ${assetUrl.size}` : ""}${plan.skipped.length ? ` · 건너뜀 ${plan.skipped.length}` : ""})`,
    null,
  );

  return NextResponse.json({
    ...summary,
    counts: {
      ...summary.counts,
      created: createdCount,
      foldersCreated: folderCount,
      skippedDuplicates: results.filter((r) => r.skipped).length,
      boardsCreated: boardCount,
      boardRowsCreated: boardRowCount,
      skippedBoardDuplicates: boardResults.filter((b) => b.skipped).length,
    },
    boards: boardResults.map((b) => ({
      path: b.path,
      title: b.title,
      project: b.projectName,
      pageId: b.pageId ?? null,
      columns: b.columns,
      rows: b.rows,
      linkedDocs: b.linkedDocs,
      duplicate: b.duplicate,
      skipped: !!b.skipped,
    })),
    attachments: [...assetUrl].map(([p, url]) => ({ path: p, url })),
    documents: results.map((r) => ({
      path: r.path,
      title: r.title,
      project: r.projectName,
      pageId: r.pageId ?? null,
      filePath: r.createdPath ?? null,
      duplicate: r.duplicate,
      attachments: r.assets.length,
      skipped: !!r.skipped,
    })),
  });
}

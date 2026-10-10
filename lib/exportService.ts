/* GET /api/export 의 본체 — 워크스페이스를 zip 엔트리로 모아 묶는다(T-3a, 라우트에서 순수 이동).
   라우트는 requireCtx("editor") 가드와 ?attachments 쿼리 파싱만 하고 여기로 넘긴다.
   여기서: 메타 일괄 조회 → D3 접근 필터 → 문서(+첨부 상대경로화)·보드 CSV·workspace.json·README → createZip → 활동 기록.
   결과는 { ok:true, zip, stamp, filename } — content-type·content-disposition 헤더는 라우트가 붙인다.
   실패(워크스페이스 없음 404)는 serviceResult 유니온으로 돌려준다. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type { Ctx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { readDoc } from "@/lib/docFiles";
import { createZip, safeZipPath, type ZipEntry } from "@/lib/zip";
import { extractLinks, isExternal, rewriteHrefs, toRelativeHref, uploadsHrefFile } from "@/lib/assets";
import { recordActivity } from "@/lib/activity";
import { uploadRoot, legacyUploadRoot } from "@/lib/uploadPaths";
import { fail, type ServiceFail } from "@/lib/serviceResult";

/** 첨부를 읽을 위치 — 새 저장소 먼저, 없으면 옛 public/uploads(OSS 후속: 파일을 옮기지 않는다). */
async function readUpload(workspaceId: string, name: string): Promise<Buffer> {
  let last: unknown;
  for (const root of [uploadRoot(), legacyUploadRoot()]) {
    try {
      return await fs.readFile(path.join(root, workspaceId, name));
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/* =====================================================================
   GET /api/export → 워크스페이스 전체를 zip 으로.

   격차조사 E1: 회수 경로가 아예 없었다. 팀 지식의 단일 진실 원천을 표방하면서
   데이터를 꺼낼 방법이 없는 건 기능 문제가 아니라 신뢰 문제다. 옵시디언의
   "네 파일은 네 디스크에 있다" 와 정반대 지점이었다.

   담는 것:
     docs/<프로젝트>/<제목>.md   — 문서 본문(파일이 원본, 없으면 markdown 캐시)
     boards/<보드>.csv           — 보드를 사람이 읽을 수 있는 표로
     workspace.json              — 구조·메타(프로젝트·보드·결정·레슨·용어집 등)
     README.md                   — 이 묶음이 무엇이고 어떻게 읽는지

   문서는 **읽을 수 있는 제목 파일명**으로 넣는다. content/ 아래 실제 파일명은
   pageId 라 사람이 못 읽는데, 내보내기의 목적이 "다른 도구로 가져가는 것"이므로
   제목이어야 의미가 있다. 충돌하면 뒤에 번호를 붙인다.
   ===================================================================== */

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 같은 폴더 안에서 파일명이 겹치면 " (2)" 를 붙인다. */
function uniquePath(used: Set<string>, path: string): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf(".");
  const stem = dot > 0 ? path.slice(0, dot) : path;
  const ext = dot > 0 ? path.slice(dot) : "";
  for (let n = 2; ; n++) {
    const cand = `${stem} (${n})${ext}`;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
}

export type ExportResult = { ok: true; zip: Buffer; stamp: string; filename: string } | ServiceFail;

export async function buildWorkspaceExport(guard: Ctx, opts: { withAttachments: boolean }): Promise<ExportResult> {
  const { workspaceId } = guard;
  const { withAttachments } = opts;

  const [ws, projects, pages, decisions, lessons, glossary, risks, qa, entities, dod, onboarding, changelog] =
    await Promise.all([
      prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, createdAt: true } }),
      prisma.project.findMany({ where: { workspaceId }, orderBy: { position: "asc" } }),
      prisma.page.findMany({
        where: { workspaceId, deletedAt: null },
        orderBy: [{ parentId: "asc" }, { position: "asc" }],
        include: { project: { select: { name: true } } },
      }),
      prisma.decision.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
      prisma.lesson.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
      prisma.glossaryTerm.findMany({ where: { workspaceId }, orderBy: { term: "asc" } }),
      prisma.risk.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
      prisma.qaScenario.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
      prisma.entity.findMany({ where: { workspaceId }, orderBy: { name: "asc" } }),
      prisma.dodItem.findMany({ where: { workspaceId }, orderBy: { position: "asc" } }),
      prisma.onboardingStep.findMany({ where: { workspaceId }, orderBy: { position: "asc" } }),
      prisma.changelogEntry.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } }),
    ]);

  if (!ws) return fail(404, "워크스페이스를 찾을 수 없습니다.");

  // D3: 내보내기는 워크스페이스를 통째로 꺼낸다 — 못 보는 문서·보드는 여기서 빠져야 한다.
  const access = await loadAccess(guard);
  const visiblePages = visibleOnly(access, pages);

  const entries: ZipEntry[] = [];
  const used = new Set<string>();
  const docIndex: { id: string; title: string; project: string | null; file: string }[] = [];

  const attachIndex: { file: string; url: string; bytes: number }[] = [];
  const attachFailed: { url: string; reason: string }[] = [];
  // 파일명 → zip 안의 경로. 여러 문서가 같은 그림을 참조해도 한 번만 담는다.
  const attachPath = new Map<string, string>();

  /* ── 문서 ── */
  for (const p of visiblePages.filter((x) => x.kind === "doc")) {
    // 파일이 원본이다. 읽기에 실패하면(경로 유실 등) markdown 캐시로 물러난다 —
    // 내보내기가 통째로 실패하는 것보다 한 문서가 캐시본인 게 낫다.
    let md = p.markdown ?? "";
    if (p.filePath) {
      try {
        md = await readDoc(p.filePath);
      } catch {
        md = p.markdown ?? "";
      }
    }
    const folder = p.project?.name ? `docs/${safeZipPath(p.project.name)}` : "docs";
    const file = uniquePath(used, `${folder}/${safeZipPath(p.title)}.md`);

    /* 첨부(E4): 본문이 가리키는 업로드 파일을 zip 에 담고, 본문의 목적지를
       **상대경로로 바꾼다**. 그래야 이 묶음이 옵시디언·VS Code 에서 그대로
       열린다 — 원래 서버 주소를 남겨 두면 서버가 사라지는 순간 그림도 사라진다. */
    if (withAttachments) {
      const map: Record<string, string> = {};
      for (const link of extractLinks(md)) {
        if (isExternal(link.href) || map[link.href]) continue;
        const name = uploadsHrefFile(link.href, workspaceId);
        if (!name) continue;
        if (!attachPath.has(name)) {
          try {
            const buf = await readUpload(workspaceId, name);
            const zipPath = uniquePath(used, `attachments/${safeZipPath(name)}`);
            entries.push({ path: zipPath, data: buf });
            attachPath.set(name, zipPath);
            attachIndex.push({ file: zipPath, url: link.href, bytes: buf.length });
          } catch {
            // 업로드가 디스크에서 사라진 경우 — 문서는 그대로 내보내고 사실만 기록한다.
            attachFailed.push({ url: link.href, reason: "파일을 찾을 수 없습니다" });
            continue;
          }
        }
        map[link.href] = toRelativeHref(file, attachPath.get(name)!);
      }
      md = rewriteHrefs(md, map);
    }

    entries.push({ path: file, data: md });
    docIndex.push({ id: p.id, title: p.title, project: p.project?.name ?? null, file });
  }

  /* ── 보드 → CSV ── */
  const boards = visiblePages.filter((x) => x.kind === "database");
  /* 보드 색인. CSV 는 타입을 잃어버리므로(무엇이 날짜였는지 select 였는지 알 수 없다)
     **열 타입·옵션을 여기 남긴다** — 가져오기가 이걸 읽어 원래 보드를 그대로 되살린다.
     파일명도 함께 남긴다: 제목의 "/" 같은 문자는 파일명에서 바뀌므로 파일명만으로는
     어느 보드였는지 되짚을 수 없다(documents[].file 과 같은 이유다). */
  const boardIndex: {
    id: string;
    title: string;
    project: string | null;
    file: string;
    properties: { name: string; type: string; options?: string[] }[];
  }[] = [];
  for (const b of boards) {
    const [props, rows] = await Promise.all([
      prisma.dbProperty.findMany({ where: { databasePageId: b.id }, orderBy: { position: "asc" } }),
      prisma.dbRow.findMany({ where: { databasePageId: b.id }, orderBy: { position: "asc" } }),
    ]);
    const optionsOf = (prop: (typeof props)[number]) =>
      ((prop.config as { options?: { id: string; name: string }[] })?.options ?? []).map((o) => o.name);
    const optName = (prop: (typeof props)[number], v: unknown) => {
      const opts = (prop.config as { options?: { id: string; name: string }[] })?.options ?? [];
      return opts.find((o) => o.id === v)?.name ?? (v == null ? "" : String(v));
    };
    const header = props.map((p) => csvCell(p.name)).join(",");
    const body = rows
      .map((r) => {
        const rec = r.props as Record<string, unknown>;
        return props
          .map((p) => csvCell(p.type === "select" || p.type === "multiselect" ? optName(p, rec[p.id]) : rec[p.id]))
          .join(",");
      })
      .join("\n");
    const file = uniquePath(used, `boards/${safeZipPath(b.title)}.csv`);
    entries.push({ path: file, data: `${header}\n${body}\n` });
    boardIndex.push({
      id: b.id,
      title: b.title,
      project: b.project?.name ?? null,
      file,
      properties: props.map((p) => ({
        name: p.name,
        type: p.type,
        ...(p.type === "select" || p.type === "multiselect" ? { options: optionsOf(p) } : {}),
      })),
    });
  }

  /* ── 구조·메타 ── */
  entries.push({
    path: "workspace.json",
    data: JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        workspace: ws,
        projects,
        documents: docIndex,
        attachments: attachIndex,
        attachmentsMissing: attachFailed,
        boards: boardIndex,
        decisions,
        lessons,
        glossary,
        risks,
        qaScenarios: qa,
        entities,
        dod,
        onboarding,
        changelog,
      },
      null,
      2,
    ),
  });

  entries.push({
    path: "README.md",
    data: [
      `# ${ws.name} — 내보내기`,
      "",
      `생성 시각: ${new Date().toISOString()}`,
      "",
      "## 무엇이 들어 있나",
      "",
      "- `docs/` — 문서 본문(마크다운). 폴더는 프로젝트 이름, 파일명은 문서 제목이다.",
      "  위키링크 `[[제목]]`·태그 `#태그`·임베드 `![[제목]]` 표기가 그대로 들어 있어",
      "  옵시디언 같은 도구에서 바로 열린다.",
      "- `boards/` — 보드(데이터베이스)를 CSV 로. select 값은 옵션 id 가 아니라 이름으로 풀어 썼다.",
      "  이 zip 을 다시 가져오면 보드·열·행이 되살아난다 — 열 타입과 옵션은 `workspace.json` 의 `boards[].properties` 에 있다.",
      ...(withAttachments
        ? [
            `- \`attachments/\` — 문서가 참조하는 첨부·이미지 ${attachIndex.length}개. 본문의 링크는`,
            "  이 폴더를 가리키는 **상대경로**로 바뀌어 있어, 서버 없이도 그림이 보인다.",
          ]
        : []),
      "- `workspace.json` — 구조와 메타. 프로젝트·결정·레슨·용어집·리스크·QA·데이터모델·",
      "  완료기준·온보딩·변경이력, 그리고 문서 id ↔ 파일 경로 대응표(`documents`)와",
      "  첨부 대응표(`attachments`).",
      "",
      "## 알아둘 것",
      "",
      ...(withAttachments
        ? attachFailed.length
          ? [`- 첨부 ${attachFailed.length}개는 디스크에서 찾지 못해 빠졌다(\`workspace.json\` 의 \`attachmentsMissing\`).`]
          : []
        : ["- `?attachments=0` 으로 받은 묶음이라 첨부는 들어 있지 않다. 본문의 이미지 링크는 원래 서버를 가리킨다."]),
      "- 어느 문서도 참조하지 않는 업로드 파일은 담지 않는다(전체 첨부 백업은 `pnpm backup` 이 맡는다).",
      "- 휴지통(소프트 삭제)에 있는 문서는 빠져 있다.",
      "- 문서 파일명은 제목 기준이라, 같은 이름이 여럿이면 뒤에 ` (2)` 가 붙는다.",
      "  원래 id 는 `workspace.json` 의 `documents` 에서 확인할 수 있다.",
      "",
    ].join("\n"),
  });

  const zip = createZip(entries);
  recordActivity(
    guard,
    "내보냄",
    "workspace",
    `${ws.name} (문서 ${docIndex.length}·보드 ${boards.length}·첨부 ${attachIndex.length})`,
    ws.id,
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `teamspace-${safeZipPath(ws.name).replace(/\//g, "-")}-${stamp}.zip`;
  return { ok: true, zip, stamp, filename };
}

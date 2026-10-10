/* /api/pages/[id] GET·PUT·PATCH·DELETE 의 본체(T-3a, 라우트에서 순수 이동).
   라우트는 requireCtx 가드·requirePage(D3) 게이트·본문 읽기만 하고 여기로 넘긴다.
   getPageContent: 메타+본문(doc 은 docFiles, 그 외는 content) / savePageContent: 제목만·baseRev 409·file-first 저장+리비전
   patchPageMeta: 404 확인 뒤 PatchBody 검증(순서 보존)·프로젝트/부모 순환 검사 / trashPage: 소프트 삭제(?recursive 서브트리).
   그래프 캐시 무효화·활동 기록·알림 호출은 원래 순서 그대로 여기서 한다. 실패는 serviceResult 유니온. */
import { z } from "zod";
import { promises as fs } from "node:fs";
import { prisma } from "@/lib/prisma";
import type { Ctx } from "@/lib/workspace";
import { isRestrictedPage } from "@/lib/pageGuard";
import { checkBaseRev } from "@/lib/concurrency";
import { recordActivity } from "@/lib/activity";
import { fireNotif } from "@/lib/notify";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { DOC_TYPES } from "@/lib/docOrganize";
import { pageFilePath, readContent, writeContent } from "@/lib/content";
import {
  readDoc,
  writeDoc,
  resolveDocPath,
  docFolderFor,
  listDocFolder,
  uniqueFileName,
} from "@/lib/docFiles";
import { fail, type ServiceFail } from "@/lib/serviceResult";

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

export type GetPageResult =
  | {
      ok: true;
      page: { id: string; title: string; icon: string | null; parentId: string | null; kind: string; rev: number };
      markdown: string;
    }
  | ServiceFail;

// GET → ページメタ + 本文(markdown)
export async function getPageContent(guard: Ctx, id: string): Promise<GetPageResult> {
  const page = await prisma.page.findUnique({ where: { id } });
  if (!page || page.workspaceId !== guard.workspaceId || page.deletedAt) {
    return fail(404, "Not found");
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

  return {
    ok: true,
    page: { id: page.id, title: page.title, icon: page.icon, parentId: page.parentId, kind: page.kind, rev: page.rev },
    markdown,
  };
}

export type SavePageInput = { markdown?: string; title?: string; baseRev?: number };
export type SavePageResult = { ok: true; rev: number } | ServiceFail<Record<string, unknown>>;

// PUT → 本文保存
//   { markdown?, title?, baseRev? } — markdown 이 없으면 본문은 건드리지 않는다(제목만 갱신, 감사 doc-1).
//   baseRev(opt-in)가 서버 rev 와 다르면 409 + 현재 상태 반환(낙관적 잠금, 감사 doc-2/inv-8).
//   본문 저장마다 rev+1 + PageRevision 적재(버전 히스토리, 감사 doc-3).
export async function savePageContent(guard: Ctx, id: string, body: SavePageInput): Promise<SavePageResult> {
  const page = await prisma.page.findUnique({ where: { id }, include: { project: true } });
  if (!page || page.workspaceId !== guard.workspaceId || page.deletedAt) {
    return fail(404, "Not found");
  }

  const title = body.title?.trim() || page.title;

  // 본문 유실 가드(doc-1): markdown 미제공 → 제목만 갱신
  if (body.markdown === undefined) {
    if (body.title === undefined) {
      return fail(400, "markdown 또는 title 이 필요합니다.");
    }
    await prisma.page.update({ where: { id }, data: { title } });
    invalidateGraphCache(guard.workspaceId); // 제목 = 언급·링크 대상
    return { ok: true, rev: page.rev };
  }

  // 낙관적 잠금(opt-in): baseRev 불일치 → 409 + 서버 상태
  const revCheck = checkBaseRev(body.baseRev, page.rev);
  if (!revCheck.ok) {
    return fail(409, "다른 곳에서 먼저 수정되었습니다. 최신 내용을 확인하고 다시 저장하세요.", {
      conflict: true,
      currentRev: revCheck.currentRev,
      currentMarkdown: page.markdown ?? "",
      currentTitle: page.title,
    });
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
    invalidateGraphCache(guard.workspaceId);
    return { ok: true, rev: nextRev };
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

  invalidateGraphCache(guard.workspaceId); // 본문이 바뀌면 링크·언급 간선이 바뀐다
  recordActivity(guard, "updated", "doc", title, id);
  // D3 후속: 비공개 문서의 제목을 채널로 뿌리지 않는다(제목 자체가 내용이다).
  void isRestrictedPage(id).then((restricted) => {
    if (!restricted) void fireNotif(guard.workspaceId, "doc_saved", `📝 ${guard.actor.name} 문서 저장: ${title}`, page.projectId);
  });
  return { ok: true, rev: nextRev };
}

export const PatchBody = z.object({
  projectId: z.string().nullable().optional(),
  title: z.string().optional(),
  icon: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  docType: z.enum(DOC_TYPES).nullable().optional(),
});

export type PatchPageResult = { ok: true } | ServiceFail<Record<string, unknown>>;

// PATCH → 페이지 메타 변경
//   { projectId?, title?, icon?, parentId?, docType? } — 주어진 필드만 갱신.
//   parentId: 폴더 이동(자기 자신/자손으로의 이동은 순환이라 거부).
//   rawBody 를 받는 이유: 원래 라우트는 404(페이지 없음)를 본문 검증(400)보다 먼저 판정했다 — 그 순서를 지킨다.
export async function patchPageMeta(guard: Ctx, id: string, rawBody: unknown): Promise<PatchPageResult> {
  const { workspaceId } = guard;
  const page = await prisma.page.findUnique({ where: { id }, select: { id: true, workspaceId: true } });
  if (!page || page.workspaceId !== workspaceId) {
    return fail(404, "Not found");
  }
  const parsed = PatchBody.safeParse(rawBody);
  if (!parsed.success) {
    return fail(400, "잘못된 요청 본문", { issues: parsed.error.issues });
  }
  const body = parsed.data;

  const data: {
    projectId?: string | null;
    title?: string;
    icon?: string | null;
    parentId?: string | null;
    docType?: (typeof DOC_TYPES)[number] | null;
  } = {};

  if (body.projectId !== undefined) {
    if (body.projectId !== null) {
      const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { workspaceId: true } });
      if (!project || project.workspaceId !== workspaceId) {
        return fail(400, "프로젝트를 찾을 수 없습니다.");
      }
    }
    data.projectId = body.projectId;
  }

  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return fail(400, "제목을 입력해 주세요.");
    data.title = title;
  }

  if (body.icon !== undefined) {
    data.icon = body.icon;
  }

  if (body.docType !== undefined) {
    data.docType = body.docType;
  }

  if (body.parentId !== undefined) {
    if (body.parentId === id) {
      return fail(400, "자기 자신으로 이동할 수 없습니다.");
    }
    if (body.parentId !== null) {
      const parent = await prisma.page.findUnique({ where: { id: body.parentId }, select: { workspaceId: true } });
      if (!parent || parent.workspaceId !== workspaceId) {
        return fail(400, "이동할 위치를 찾을 수 없습니다.");
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
        return fail(400, "하위 항목으로는 이동할 수 없습니다.");
      }
    }
    data.parentId = body.parentId;
  }

  if (Object.keys(data).length === 0) {
    return fail(400, "변경할 내용이 없습니다.");
  }

  await prisma.page.update({ where: { id }, data });
  invalidateGraphCache(workspaceId); // 제목·폴더·프로젝트 변경은 노드·contains 간선에 반영
  return { ok: true };
}

export type TrashPageResult = { ok: true; trashed: number } | ServiceFail;

// DELETE → **소프트 삭제**(휴지통, 감사 inv-1). `.md` 파일은 보존.
//   recursive 면 서브트리 일괄 — 단일 updateMany 라 반쪽 삭제 없음(감사 inv-23).
//   영구 삭제(파일 unlink 포함)는 /api/trash/[id] DELETE 로 분리.
export async function trashPage(guard: Ctx, id: string, opts: { recursive: boolean }): Promise<TrashPageResult> {
  const { workspaceId } = guard;
  const { recursive } = opts;

  const page = await prisma.page.findUnique({ where: { id }, include: { children: true } });
  if (!page || page.workspaceId !== workspaceId || page.deletedAt) {
    return fail(404, "Not found");
  }

  const liveChildren = page.children.filter((c) => !c.deletedAt);
  if (liveChildren.length > 0 && !recursive) {
    return fail(409, "Has children");
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
  invalidateGraphCache(workspaceId);
  recordActivity(guard, "deleted", page.kind === "database" ? "board" : "doc", page.title, id);
  return { ok: true, trashed: ids.length };
}

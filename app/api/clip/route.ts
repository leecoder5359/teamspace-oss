import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { writeDoc, docFolderFor, listDocFolder, uniqueFileName } from "@/lib/docFiles";
import { complete } from "@/lib/llm";
import { buildClassifyPrompt, parseClassification, buildClipMarkdown } from "@/lib/clip";

export const runtime = "nodejs";

// POST /api/clip { url, title?, text, html? } → 웹 내용을 요약·자동분류해 doc 페이지로 저장.
//   { ok, pageId, projectId, projectName, summary, mode("classified"|"plain") }
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;
  const body = (await request.json().catch(() => ({}))) as { url?: string; title?: string; text?: string; html?: string };
  const url = body.url?.trim() ?? "";
  const text = (body.text ?? "").trim();
  const title = body.title?.trim() || url || "웹 클립";
  if (!text && !url) return NextResponse.json({ error: "text 또는 url 이 필요합니다." }, { status: 400 });

  const projects = await prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true, description: true },
  });

  // LLM 분류·요약(없으면 원문만 저장: plain)
  const raw = text ? await complete(buildClassifyPrompt(projects, title, text)) : null;
  const { projectId, summary } = raw
    ? parseClassification(raw, projects.map((p) => p.id))
    : { projectId: null, summary: "" };

  // file-first doc 페이지 생성(pages POST 와 동일 방식)
  const project = projectId ? projects.find((p) => p.id === projectId) ?? null : null;
  const folder = docFolderFor(project ? { docsDir: null, name: project.name } : null);
  const existing = await listDocFolder(folder);
  const filename = uniqueFileName(existing, title);
  const filePath = `${folder}/${filename}`;
  const markdown = buildClipMarkdown(title, url, summary, text);
  await writeDoc(filePath, markdown);

  const last = await prisma.page.findFirst({
    where: { workspaceId, parentId: null },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const page = await prisma.page.create({
    data: {
      workspaceId,
      title,
      position: (last?.position ?? -1) + 1,
      kind: "doc",
      projectId,
      createdById: userId,
      markdown,
      filePath,
    },
  });

  return NextResponse.json({
    ok: true,
    pageId: page.id,
    projectId,
    projectName: project?.name ?? null,
    summary,
    mode: raw ? "classified" : "plain",
  });
}

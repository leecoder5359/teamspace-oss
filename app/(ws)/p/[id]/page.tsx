import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { pageAccess } from "@/lib/pageGuard";
import { getRenderAccess, getRenderContext } from "@/lib/renderContext";
import { getPageContent } from "@/lib/pageService";
import PageView from "@/components/PageView";
import DatabaseView from "@/components/DatabaseView";

/** 탭 제목 = 문서 제목. 본문과 같은 게이트(접근·휴지통·워크스페이스)를 통과할 때만 — 못 보는 문서의 제목이 새지 않게. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const ctx = await getRenderContext();
  if (pageAccess(await getRenderAccess(), id) === "none") return {};
  const page = await prisma.page.findUnique({ where: { id }, select: { title: true, deletedAt: true, workspaceId: true } });
  if (!page || page.deletedAt || page.workspaceId !== ctx.workspaceId) return {};
  return { title: page.title || "제목 없음" };
}

export default async function PagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // D3: 화면도 게이트를 통과해야 한다. API 만 막으면 서버 렌더가 제목·본문을 먼저 그린다.
  // 레이아웃이 이미 만든 컨텍스트·접근 색인을 재사용한다(렌더당 한 번 — lib/renderContext).
  const ctx = await getRenderContext();
  const access = await getRenderAccess();
  if (pageAccess(access, id) === "none") notFound();

  const page = await prisma.page.findUnique({ where: { id }, select: { kind: true, deletedAt: true, workspaceId: true } });
  // 없는 id·휴지통 문서·다른 워크스페이스 문서는 역할(admin 포함)과 무관하게 404 (API 와 동일 —
  // pageAccess 는 admin 에게 아무 id 나 "edit" 을 주므로 워크스페이스 소속을 여기서 따로 본다).
  if (!page || page.deletedAt || page.workspaceId !== ctx.workspaceId) notFound();
  if (page.kind === "database") return <DatabaseView pageId={id} />;
  // 본문을 서버에서 같이 읽어 넘긴다 — 편집기가 하이드레이션 뒤 /api/pages/<id> 를 한 번 더 왕복하지 않게.
  // GET /api/pages/<id> 와 같은 게이트(위의 pageAccess)·같은 함수(getPageContent)라 응답 모양·rev 가 같다.
  // 실패하면 null — 편집기가 종전대로 API 로 받는다. nonce 는 '한 번만 쓰기' 표식(lib/pagePrefetch).
  let content: Awaited<ReturnType<typeof getPageContent>> | null = null;
  try {
    content = await getPageContent(ctx, id);
  } catch {
    /* 파일 읽기 실패 등 — 편집기가 API 로 다시 시도한다 */
  }
  const initial = content?.ok ? { page: content.page, markdown: content.markdown, nonce: randomUUID() } : null;
  // kind="doc" → 파일 기반 마크다운 에디터(RawDocEditor); 그 외 → 기존 BlockNote
  return <PageView pageId={id} fileBacked={page.kind === "doc"} initial={initial} />;
}

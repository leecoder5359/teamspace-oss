import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";
import { loadAccess, pageAccess } from "@/lib/pageGuard";
import PageView from "@/components/PageView";
import DatabaseView from "@/components/DatabaseView";

export default async function PagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // D3: 화면도 게이트를 통과해야 한다. API 만 막으면 서버 렌더가 제목·본문을 먼저 그린다.
  const ctx = await getPageContext();
  const access = await loadAccess(ctx);
  if (pageAccess(access, id) === "none") notFound();

  const page = await prisma.page.findUnique({ where: { id }, select: { kind: true, deletedAt: true, workspaceId: true } });
  // 없는 id·휴지통 문서·다른 워크스페이스 문서는 역할(admin 포함)과 무관하게 404 (API 와 동일 —
  // pageAccess 는 admin 에게 아무 id 나 "edit" 을 주므로 워크스페이스 소속을 여기서 따로 본다).
  if (!page || page.deletedAt || page.workspaceId !== ctx.workspaceId) notFound();
  if (page.kind === "database") return <DatabaseView pageId={id} />;
  // kind="doc" → 파일 기반 마크다운 에디터(RawDocEditor); 그 외 → 기존 BlockNote
  return <PageView pageId={id} fileBacked={page.kind === "doc"} />;
}

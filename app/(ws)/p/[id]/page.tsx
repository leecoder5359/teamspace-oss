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

  const page = await prisma.page.findUnique({ where: { id }, select: { kind: true } });
  if (page?.kind === "database") return <DatabaseView pageId={id} />;
  // kind="doc" → 파일 기반 마크다운 에디터(RawDocEditor); 그 외(null 등) → 기존 BlockNote
  return <PageView pageId={id} fileBacked={page?.kind === "doc"} />;
}

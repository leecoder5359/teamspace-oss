import { prisma } from "@/lib/prisma";
import PageView from "@/components/PageView";
import DatabaseView from "@/components/DatabaseView";

export default async function PagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const page = await prisma.page.findUnique({ where: { id }, select: { kind: true } });
  if (page?.kind === "database") return <DatabaseView pageId={id} />;
  // kind="doc" → 파일 기반 마크다운 에디터(RawDocEditor); 그 외(null 등) → 기존 BlockNote
  return <PageView pageId={id} fileBacked={page?.kind === "doc"} />;
}

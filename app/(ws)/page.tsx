import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";

export default async function Home() {
  const { workspaceId } = await getPageContext();
  const first = await prisma.page.findFirst({
    where: { workspaceId },
    orderBy: [{ position: "asc" }],
    select: { id: true },
  });
  if (first) redirect(`/p/${first.id}`);

  return (
    <div className="ws-empty">
      <p>아직 페이지가 없습니다.</p>
      <p>왼쪽 사이드바의 <strong>+</strong> 버튼으로 첫 페이지를 만들어보세요.</p>
    </div>
  );
}

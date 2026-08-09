import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getPageContext } from "@/lib/workspace";
import { loadAccess, pageAccess } from "@/lib/pageGuard";

export default async function Home() {
  const ctx = await getPageContext();
  const pages = await prisma.page.findMany({
    where: { workspaceId: ctx.workspaceId, deletedAt: null },
    orderBy: [{ position: "asc" }],
    select: { id: true },
  });
  // D3: 첫 페이지로 보낼 때도 **내가 볼 수 있는** 첫 페이지여야 한다.
  // (그러지 않으면 로그인 직후 404 로 튕기거나, 더 나쁘게는 남의 문서로 들어간다.)
  const access = await loadAccess(ctx);
  const first = pages.find((p) => pageAccess(access, p.id) !== "none");
  if (first) redirect(`/p/${first.id}`);

  return (
    <div className="ws-empty">
      <p>아직 페이지가 없습니다.</p>
      <p>왼쪽 사이드바의 <strong>+</strong> 버튼으로 첫 페이지를 만들어보세요.</p>
    </div>
  );
}

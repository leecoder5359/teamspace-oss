import { auth } from "@/auth";
import { currentSlugForAlias } from "@/lib/sites/server";
import { SHELL_PREFIX, splitLegacyShellPath } from "@/lib/sites/shellPath";

/* =====================================================================
   옛 공유 주소 /s/<slug>[/<하위 경로>] → /pages/<slug>[/<하위 경로>] 영구 308.
   셸 본체는 app/pages/[slug]/[[...path]]/page.tsx 다. 이미 나간 링크(슬랙·메일·문서)가
   계속 열리도록 남겨 둔다.

   - 판정(초대·멤버)은 하지 않는다 — 넘어간 /pages 셸이 매번 한다. middleware 도 /s/ 는
     로그인 없이 통과시켜, 비로그인이면 /pages 에서 callbackUrl=/pages/… 로 로그인에 간다.
   - 하위 경로·쿼리는 받은 그대로(원본 인코딩 유지) 붙인다.
   - 옛 슬러그(별칭)는 **로그인한 요청에서만** 현재 슬러그로 풀어 한 번에 정식 주소로 보낸다.
     비로그인 요청까지 풀면 익명으로 별칭→현재 슬러그를 조회할 수 있게 되므로(지금 셸도 로그인 후에만
     푼다) 그때는 같은 슬러그로 보내고, /pages 셸이 로그인 뒤 별칭 308 을 한 번 더 한다.
   - Location 은 상대 경로 — Funnel 뒤에서 요청 origin 이 localhost 일 수 있어서다.
   ===================================================================== */

export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const parts = splitLegacyShellPath(url.pathname);
  if (!parts) return new Response("Not Found", { status: 404 });

  let target = parts.rawSlug;
  const session = await auth().catch(() => null);
  if (session?.user?.email) {
    const current = await currentSlugForAlias(parts.slug).catch(() => null);
    if (current && current !== parts.slug) target = encodeURIComponent(current);
  }
  const location = `${SHELL_PREFIX}/${target}${parts.rest}${url.search}`;
  return new Response(null, { status: 308, headers: { Location: location } });
}

export const GET = handle;

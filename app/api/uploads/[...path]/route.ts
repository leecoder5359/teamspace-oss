import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { requireCtx } from "@/lib/workspace";
import {
  safeUploadSegments,
  uploadFilePath,
  uploadRoot,
  legacyUploadRoot,
  contentTypeFor,
  dispositionFor,
  cspFor,
} from "@/lib/uploadPaths";

export const runtime = "nodejs";

/* =====================================================================
   GET /api/uploads/<workspaceId>/<파일명> → 첨부 서빙 (OSS 후속)

   전에는 `public/uploads/` 에 두고 Next 정적 서빙에 맡겼다. 두 가지가 틀렸다:

   ① **인증이 없었다.** URL 만 알면 남의 워크스페이스 첨부까지 받을 수 있었다.
      문서에 자물쇠(D3)를 달아 두고 그 문서에 붙은 그림은 공개인 상태였다.
   ② **프로덕션에서 빌드 후 생긴 파일의 서빙이 보장되지 않는다.** `public/` 을
      빌드 산출물로 다루는 배포에서는 런타임에 쓴 파일이 안 보이거나 사라진다.

   그래서 저장은 레포 밖(`DATA_DIR/uploads`), 서빙은 이 라우트가 한다.
   `next.config.ts` 의 beforeFiles rewrite 가 기존 `/uploads/...` 링크를 여기로
   보내므로, 이미 저장된 본문의 링크를 고칠 필요가 없다.

   **워크스페이스가 다르면 404** 다(403 이 아니다) — 존재 여부조차 알리지 않는다.
   ===================================================================== */

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;

  const { path: segments } = await ctx.params;
  const ref = safeUploadSegments((segments ?? []).map((s) => decodeURIComponent(s)));
  const notFound = () => NextResponse.json({ error: "파일을 찾을 수 없습니다." }, { status: 404 });
  if (!ref) return notFound();
  // 남의 워크스페이스 첨부는 없는 것으로 취급한다.
  if (ref.workspaceId !== guard.workspaceId) return notFound();

  // 새 위치를 먼저, 없으면 옛 위치(public/uploads). 이미 올라간 파일을 옮기지 않고도
  // 새 저장소로 넘어가기 위한 유일한 장치다.
  let data: Buffer | null = null;
  for (const root of [uploadRoot(), legacyUploadRoot()]) {
    const full = uploadFilePath(root, ref);
    if (!full) return notFound();
    try {
      data = await fs.readFile(full);
      break;
    } catch {
      // 다음 루트로
    }
  }
  if (!data) return notFound();

  const type = contentTypeFor(ref.filename);
  const disposition = dispositionFor(type);
  // 파일명은 내용 해시가 붙은 불변 이름이라(lib/assets.uploadFileName) 길게 캐시해도
  // 안전하다. private 인 이유는 세션 기반 응답이라 공용 캐시에 남으면 안 되기 때문.
  const headers: Record<string, string> = {
    "content-type": type,
    "content-length": String(data.length),
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(ref.filename)}`,
    // 확장자를 못 믿는 브라우저가 내용을 보고 html 로 승격하는 것을 막는다.
    "x-content-type-options": "nosniff",
    // 직접 열었을 때 그 안의 스크립트·외부 요청을 무력화한다(svg 는 sandbox 까지).
    "content-security-policy": cspFor(type),
  };
  return new NextResponse(new Uint8Array(data), { headers });
}

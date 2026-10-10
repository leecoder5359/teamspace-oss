import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { importZip, MAX_BYTES } from "@/lib/importService";
import { failResponse } from "@/lib/serviceResult";

export const runtime = "nodejs";

/* =====================================================================
   POST /api/import (multipart) → zip 안의 마크다운을 문서로 가져온다.

   격차조사 E2: E1(내보내기)의 짝이 없었다. 넣을 수 없는 저장소는 옮겨 오는
   비용이 무한대라 "쓰기 시작할 수" 가 없다.

   받는 것: 우리 export zip · 노션 export zip · 그냥 마크다운 폴더 zip.
   판별·정규화는 전부 순수 함수(lib/importPlan)에 있고, IO 는 lib/importService 가 한다.
   이 라우트는 가드·크기 선검사·폼 파싱만 한다.

   **드라이런이 기본이 아닌 대신 1급 시민이다**(`?dryRun=1`). 수십~수백 개
   문서를 만드는 되돌릴 수 없는 작업이라, 무엇이 생기고 무엇이 버려지는지를
   같은 계산으로 먼저 보여준다. 미리보기와 실행이 다른 코드를 타면 미리보기는
   있으나 마나이므로 planImport 하나만 쓴다.

   권한은 E1 과 대칭으로 editor — editor 는 어차피 /api/pages 로 문서를 만들 수
   있다. 벌크라는 사실은 역할이 아니라 활동 로그로 남긴다.
   ===================================================================== */

export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;

  const url = new URL(req.url);

  // 크기는 **본문을 읽기 전에** 본다. 뒤에서 file.size 로도 보지만, 그때는 이미
  // 수백 MB 를 메모리에 올린 뒤다. content-length 를 못 믿는 경우가 있어 둘 다 둔다.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BYTES + 1024 * 1024) {
    return NextResponse.json({ error: `zip 이 너무 큽니다(최대 ${MAX_BYTES / 1024 / 1024}MB).` }, { status: 413 });
  }

  let formErr: string | null = null;
  const form = await req.formData().catch((e: unknown) => {
    formErr = (e as Error)?.message ?? String(e);
    return null;
  });
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: `multipart form-data 의 file 필드(zip)가 필요합니다.${formErr ? ` (본문을 읽지 못했습니다: ${formErr})` : ""}` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: `zip 이 너무 큽니다(최대 ${MAX_BYTES / 1024 / 1024}MB).` }, { status: 413 });
  }

  const str = (k: string) => {
    const v = form?.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const truthy = (v: string) => v === "1" || v === "true" || v === "on";

  const result = await importZip(guard, {
    file,
    // 드라이런은 쿼리로도 폼 필드로도 받는다 — CLI 는 쿼리, 화면 폼은 필드가 자연스럽다.
    dryRun: truthy(url.searchParams.get("dryRun") ?? "") || truthy(str("dryRun")),
    createProjects: truthy(str("createProjects")),
    skipExisting: truthy(str("skipExisting")),
    projectRef: str("projectId"),
  });
  if (!result.ok) return failResponse(result);
  return NextResponse.json(result);
}

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { buildWorkspaceExport } from "@/lib/exportService";
import { failResponse } from "@/lib/serviceResult";

export const runtime = "nodejs";

/* =====================================================================
   GET /api/export → 워크스페이스 전체를 zip 으로.

   격차조사 E1: 회수 경로가 아예 없었다. 팀 지식의 단일 진실 원천을 표방하면서
   데이터를 꺼낼 방법이 없는 건 기능 문제가 아니라 신뢰 문제다. 옵시디언의
   "네 파일은 네 디스크에 있다" 와 정반대 지점이었다.

   담는 것(조립은 lib/exportService):
     docs/<프로젝트>/<제목>.md   — 문서 본문(파일이 원본, 없으면 markdown 캐시)
     boards/<보드>.csv           — 보드를 사람이 읽을 수 있는 표로
     workspace.json              — 구조·메타(프로젝트·보드·결정·레슨·용어집 등)
     README.md                   — 이 묶음이 무엇이고 어떻게 읽는지
   ===================================================================== */

export async function GET(request: Request) {
  // editor 를 요구한다 — admin 이 아니다.
  //
  // editor 는 이미 개별 API 로 이 데이터를 전부 읽을 수 있다. 그러니 export 에만
  // admin 을 걸면 실질 보호는 없이 **회수 경로만 막는** 셈이 된다(E1 의 취지가
  // 정확히 그 반대다). 대신 벌크 반출이라는 사실을 활동 로그에 남겨 감사 가능하게
  // 한다 — 통제는 역할 게이트가 아니라 기록으로 건다.
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;

  // 첨부 동봉 여부(기본 포함). 47MB 짜리 업로드 디렉터리를 매번 받고 싶지 않을 때 ?attachments=0.
  const withAttachments = new URL(request.url).searchParams.get("attachments") !== "0";

  const result = await buildWorkspaceExport(guard, { withAttachments });
  if (!result.ok) return failResponse(result);
  const { zip, stamp, filename } = result;

  return new NextResponse(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      // RFC 5987 로 한글 워크스페이스 이름도 안전하게 넘긴다
      "content-disposition": `attachment; filename="export-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "content-length": String(zip.length),
    },
  });
}

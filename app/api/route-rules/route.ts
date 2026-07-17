import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/route-rules → cwd→프로젝트 매핑 목록 (컨텍스트 주입·ingest 라우팅용, W3)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const rules = await prisma.workspaceRouteRule.findMany({
    where: { workspaceId: guard.workspaceId },
    orderBy: [{ priority: "desc" }, { cwdPrefix: "asc" }],
  });
  return NextResponse.json({ rules });
}

// POST /api/route-rules { cwdPrefix, projectId?, priority? } → 매핑 추가 (editor)
// 설치기(curl|sh) 재실행 경로가 페어링 발급 editor 토큰으로 이 라우트를 호출한다.
// 본인 워크스페이스의 cwd→프로젝트 매핑 등록은 editor 권한으로 충분(admin 은 과도한 요구).
// 삭제(DELETE /api/route-rules/[id])는 admin 유지.
export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as {
    cwdPrefix?: string;
    projectId?: string | null;
    priority?: number;
  };
  const cwdPrefix = body.cwdPrefix?.trim() ?? "";
  if (!cwdPrefix.startsWith("/")) {
    return NextResponse.json({ error: "cwdPrefix 는 절대경로 접두사여야 합니다." }, { status: 400 });
  }
  if (body.projectId) {
    const p = await prisma.project.findUnique({ where: { id: body.projectId }, select: { workspaceId: true } });
    if (!p || p.workspaceId !== guard.workspaceId) {
      return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
    }
  }
  const rule = await prisma.workspaceRouteRule.create({
    data: {
      workspaceId: guard.workspaceId,
      cwdPrefix,
      projectId: body.projectId ?? null,
      priority: body.priority ?? 0,
    },
  });
  return NextResponse.json({ rule });
}

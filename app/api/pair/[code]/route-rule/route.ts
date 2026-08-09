import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { pairingState, isPairingCode } from "@/lib/pairing";

export const runtime = "nodejs";

// POST /api/pair/<code>/route-rule { cwd, projectId }
// 페어링(만료 전)이 인증 게이트. 브라우저 Google 로그인으로 증명된 세션이므로
// route-rule 을 role 무관하게 upsert 한다(사용자 본인 머신의 경로 매핑).
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  // 모양이 아니면 DB 까지 갈 이유가 없다(계약은 lib/pairing 한 곳에만 둔다).
  if (!isPairingCode(code)) return NextResponse.json({ error: "bad code" }, { status: 400 });
  const row = await prisma.pairing.findUnique({ where: { code } });
  if (!row) {
    return NextResponse.json({ error: "페어링을 찾을 수 없습니다." }, { status: 410 });
  }
  if (pairingState(row, new Date()) === "expired") {
    return NextResponse.json({ error: "페어링이 만료되었습니다." }, { status: 410 });
  }
  const { cwd, projectId } = (await req.json().catch(() => ({}))) as { cwd?: string; projectId?: string };
  if (!cwd || !cwd.startsWith("/")) {
    return NextResponse.json({ error: "cwd 는 절대경로여야 합니다." }, { status: 400 });
  }
  if (projectId) {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
    if (!p || p.workspaceId !== row.workspaceId) {
      return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
    }
  }
  const existing = await prisma.workspaceRouteRule.findFirst({ where: { workspaceId: row.workspaceId, cwdPrefix: cwd } });
  if (existing) return NextResponse.json({ rule: existing, deduped: true });
  const rule = await prisma.workspaceRouteRule.create({
    data: { workspaceId: row.workspaceId, cwdPrefix: cwd, projectId: projectId ?? null, priority: 10 },
  });
  return NextResponse.json({ rule });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import type { Role } from "@/app/generated/prisma/enums";

const VALID_ROLES: Role[] = ["admin", "editor", "viewer"];

// GET /api/members → 현재 워크스페이스 멤버 목록 (user 정보 포함)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, status: { not: "removed" } },
    include: {
      user: {
        select: { id: true, name: true, email: true, image: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ members });
}

// POST /api/members → 이메일로 멤버 추가 (없으면 User 자동 생성)
export async function POST(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as {
    email?: string;
    role?: Role;
  };

  const email = body.email?.trim() ?? "";
  if (!email.includes("@")) {
    return NextResponse.json({ error: "유효한 이메일 주소를 입력해 주세요." }, { status: 400 });
  }

  const role: Role =
    body.role && VALID_ROLES.includes(body.role) ? body.role : "editor";

  // find-or-create User
  const emailLocal = email.split("@")[0];
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, name: emailLocal },
    });
  }

  // 이미 멤버이면 409. 단, removed 는 관리자 재초대로 invited 복귀 허용.
  const existing = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: user.id } },
  });
  if (existing && existing.status !== "removed") {
    return NextResponse.json({ error: "이미 워크스페이스 멤버입니다." }, { status: 409 });
  }
  if (existing) {
    const member = await prisma.workspaceMember.update({
      where: { id: existing.id },
      data: { status: "invited", role },
      include: { user: { select: { id: true, name: true, email: true, image: true } } },
    });
    return NextResponse.json({ member });
  }

  // 초대: 미수락 상태로 추가. 해당 사용자가 로그인하면 getContext 에서 active 로 자동 수락.
  const member = await prisma.workspaceMember.create({
    data: { workspaceId, userId: user.id, role, status: "invited" },
    include: {
      user: { select: { id: true, name: true, email: true, image: true } },
    },
  });

  return NextResponse.json({ member });
}

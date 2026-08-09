import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import type { Role } from "@/app/generated/prisma/enums";
import { roleAtLeast } from "@/lib/authz";
import { hashToken, isAgentTokenFormat } from "@/lib/agentToken";

export const WS_COOKIE = "ws_active";

const LEGACY_AGENT_EMAIL = "legacy-cli@agents.teamspace.local";

export type Ctx = {
  workspaceId: string;
  userId: string;
  role: Role;
  actor: { type: "user" | "agent"; id: string; name: string };
};

export type CtxResult = Ctx | { err: NextResponse };

function unauthorized(message = "unauthorized"): { err: NextResponse } {
  return { err: NextResponse.json({ error: message }, { status: 401 }) };
}
function forbidden(message = "forbidden"): { err: NextResponse } {
  return { err: NextResponse.json({ error: message }, { status: 403 }) };
}

async function selectedWorkspaceId(): Promise<string | undefined> {
  try {
    return (await cookies()).get(WS_COOKIE)?.value;
  } catch {
    return undefined; // cookies() 불가 컨텍스트
  }
}

/**
 * 세션(로그인 사용자) → Ctx. 매 요청 멤버십을 검증한다:
 * 제거(removed)된 멤버는 JWT 세션이 살아 있어도 즉시 접근을 잃는다.
 */
async function resolveSessionCtx(): Promise<Ctx | null | { err: NextResponse }> {
  const session = await auth().catch(() => null);
  const sUser = session?.user;
  if (!sUser || (!sUser.id && !sUser.email)) return null;

  const user = await prisma.user.findFirst({
    where: {
      OR: [
        ...(sUser.id ? [{ id: sUser.id }] : []),
        ...(sUser.email ? [{ email: sUser.email }] : []),
      ],
    },
    select: { id: true, name: true, email: true },
  });
  if (!user) return null;

  // 초대 수락: invited → active (이메일 기반 자동 수락)
  await prisma.workspaceMember
    .updateMany({ where: { userId: user.id, status: "invited" }, data: { status: "active" } })
    .catch(() => {});

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: user.id, status: "active" },
    orderBy: { createdAt: "asc" },
  });

  // 선택 쿠키는 반드시 본인 멤버십 안에서만 유효 (임의 워크스페이스 전환 차단)
  let member: (typeof memberships)[number] | null = memberships[0] ?? null;
  const selected = await selectedWorkspaceId();
  if (selected) {
    const m = memberships.find((x) => x.workspaceId === selected);
    if (m) member = m;
  }

  // 멤버십이 없으면 기본 워크스페이스 자동 가입 — 단, removed 이력이 있으면 차단(재가입 방지).
  // (로그인 자체는 signIn 게이트(초대/허용 도메인)가 이미 거른다.)
  if (!member) {
    const workspace = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    if (!workspace) return forbidden("워크스페이스가 없습니다.");
    const removed = await prisma.workspaceMember.findFirst({
      where: { workspaceId: workspace.id, userId: user.id, status: "removed" },
      select: { id: true },
    });
    if (removed) return forbidden("이 워크스페이스에서 제거된 계정입니다. 관리자에게 재초대를 요청하세요.");
    try {
      member = await prisma.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: user.id, role: "editor" },
      });
    } catch {
      member = await prisma.workspaceMember.findFirst({
        where: { userId: user.id, status: "active" },
        orderBy: { createdAt: "asc" },
      });
    }
  }
  if (!member || member.status !== "active") return forbidden("워크스페이스 멤버가 아닙니다.");

  return {
    workspaceId: member.workspaceId,
    userId: user.id,
    role: member.role,
    actor: { type: "user", id: user.id, name: user.name ?? user.email ?? user.id },
  };
}

/** AUTH_OPEN_API=true 일 때만 쓰이는 부트스트랩 admin Ctx.
 *  (AUTH_CLI_TOKEN 경로는 D12 에서 제거 — 이제 이 함수의 유일한 호출자는 그 탈출구다.) */
async function resolveLegacyCtx(): Promise<Ctx | { err: NextResponse }> {
  // 워크스페이스: ws_active 쿠키(존재 검증) 우선, 없으면 첫 번째
  let workspace: { id: string } | null = null;
  const selected = await selectedWorkspaceId();
  if (selected) {
    workspace = await prisma.workspace.findUnique({ where: { id: selected }, select: { id: true } });
  }
  if (!workspace) {
    workspace = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  }
  if (!workspace) return forbidden("워크스페이스가 없습니다. `pnpm db:seed` 먼저 실행하세요.");

  // 작성자 귀속: 사람 멤버로 위장하지 않고 전용 시스템 User 를 사용한다.
  const user = await prisma.user.upsert({
    where: { email: LEGACY_AGENT_EMAIL },
    create: { email: LEGACY_AGENT_EMAIL, name: "legacy-cli" },
    update: {},
    select: { id: true },
  });

  return {
    workspaceId: workspace.id,
    userId: user.id,
    role: "admin",
    actor: { type: "agent", id: user.id, name: "legacy-cli" },
  };
}

/** 에이전트 토큰(wst_…) → 토큰에 박힌 워크스페이스·역할·시스템 User Ctx. */
async function resolveAgentCtx(token: string): Promise<Ctx | { err: NextResponse }> {
  const t = await prisma.agentToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!t || t.revokedAt) return unauthorized("유효하지 않은 에이전트 토큰입니다.");
  prisma.agentToken
    .update({ where: { id: t.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return {
    workspaceId: t.workspaceId,
    userId: t.userId,
    role: t.role,
    actor: { type: "agent", id: t.userId, name: t.name },
  };
}

/**
 * API 라우트 컨텍스트 해석 + RBAC 강제 (W1).
 *
 * 해석 순서: ① 로그인 세션(매 요청 멤버십 검증) ② x-ws-token — 레거시 AUTH_CLI_TOKEN(timing-safe)
 * ③ x-ws-token — AgentToken(wst_) ④ AUTH_OPEN_API=true 데모 개방 ⑤ 401.
 * 첫-멤버 위장 폴백은 제거되었다.
 *
 * 사용:
 *   const ctx = await requireCtx("editor");
 *   if ("err" in ctx) return ctx.err;
 */
export async function requireCtx(min: Role = "viewer"): Promise<CtxResult> {
  let ctx: Ctx | null = null;

  const fromSession = await resolveSessionCtx();
  if (fromSession && "err" in fromSession) return fromSession;
  ctx = fromSession;

  if (!ctx) {
    let token: string | null = null;
    try {
      token = (await headers()).get("x-ws-token");
    } catch {
      token = null;
    }
    // AUTH_CLI_TOKEN(공유 admin 토큰) 경로는 제거했다.
    //
    // README·SKILL.md 는 오래전부터 '폐기'라고 적어 두었는데 코드에는 살아 있어서,
    // 그 변수를 어딘가에 설정하기만 하면 누구든 admin 컨텍스트를 얻을 수 있었다
    // (경고는 console.warn 뿐). 문서가 없다고 말하는 뒷문은 존재 자체가 위험하다
    // — 아무도 그게 있는 줄 모르니 회수도 감사도 안 된다(전수조사 D12).
    // 대체 경로는 에이전트 토큰(wst_): `pnpm ws token add`.
    if (token && isAgentTokenFormat(token)) {
      const r = await resolveAgentCtx(token);
      if ("err" in r) return r;
      ctx = r;
    } else if (token) {
      return unauthorized("유효하지 않은 토큰입니다.");
    } else if (process.env.AUTH_OPEN_API === "true") {
      // ⚠️ 데모/로컬 전용 탈출구. 켜면 **토큰 없이 누구나 admin** 이 된다.
      // 이 서버는 tailscale 로 공개돼 있으므로 상시 배포에서는 절대 켜지 말 것.
      // (README 에 위험 표기와 함께 문서화 — 코드에만 있는 스위치를 없앤다)
      const r = await resolveLegacyCtx();
      if ("err" in r) return r;
      ctx = r;
    } else {
      return unauthorized();
    }
  }

  if (!roleAtLeast(ctx.role, min)) {
    return forbidden(`이 작업에는 ${min} 이상의 역할이 필요합니다 (현재: ${ctx.role}).`);
  }
  return ctx;
}

/**
 * 서버 컴포넌트(app/(ws) 페이지)용 컨텍스트. 미인증/무멤버십이면 /login 으로 보낸다.
 * (UI 페이지는 middleware 가 이미 세션을 요구하지만, 멤버십 상실은 여기서 걸러진다.)
 */
export async function getPageContext(): Promise<Ctx> {
  const r = await requireCtx("viewer");
  if ("err" in r) redirect("/login?error=AccessDenied");
  return r;
}

/**
 * @deprecated 세션·토큰 없이 첫 워크스페이스/첫 멤버를 돌려주던 폴백.
 * ingest(HMAC 자체 인증) 경로의 워크스페이스 라우팅 폴백에만 남아 있다.
 */
export async function getDefaultContext() {
  const workspace = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (!workspace) throw new Error("No workspace. Run `pnpm db:seed` first.");
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "asc" },
  });
  if (!member) throw new Error("No workspace member.");
  return { workspaceId: workspace.id, userId: member.userId };
}

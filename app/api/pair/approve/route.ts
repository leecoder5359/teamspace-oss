import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { generateAgentToken, hashToken, agentEmail } from "@/lib/agentToken";
import { isPairingCode } from "@/lib/pairing";
import { viewerPersonId } from "@/lib/viewerPerson";

export const runtime = "nodejs";

/* POST /api/pair/approve { code } — 로그인 사용자가 CLI 페어링을 승인.
   에이전트 토큰(+시스템 User+멤버십)을 발급하고 code 에 결속한다. 재승인 시 code upsert.

   같은 code 로 동시에 두 번 승인되면(승인 버튼 두 번 클릭·탭 두 개) 예전 구현은
   **구 토큰 조회를 트랜잭션 밖에서** 했다: 둘 다 "이전 토큰 없음" 을 보고 각자
   토큰을 만들고, upsert 는 하나만 이기니 **진 쪽의 유효한 토큰이 어디에도 묶이지
   않은 채 남았다**(회수할 화면조차 없는 고아 토큰). 그래서 code 단위 advisory
   lock 으로 트랜잭션을 직렬화하고, 조회·무력화·발급·결속을 한 트랜잭션 안에서 한다. */
export async function POST(req: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!isPairingCode(code)) {
    return NextResponse.json({ error: "유효하지 않은 페어링 코드입니다." }, { status: 400 });
  }
  const token = generateAgentToken();
  const name = `setup:${new Date().toISOString().slice(0, 10)}`;
  await prisma.$transaction(async (tx) => {
    // code 단위 직렬화. 트랜잭션이 끝나면 자동으로 풀린다(xact). 행이 아직 없어도
    // 되는 게 요점 — 첫 승인 둘이 부딪히는 경우까지 막아야 한다(FOR UPDATE 는
    // 없는 행을 잠글 수 없어서 그 경합을 못 막는다).
    // $queryRaw 가 아니라 $executeRaw 다 — 이 함수의 반환 타입이 void 라서
    // $queryRaw 는 "Failed to deserialize column of type 'void'" 로 죽는다.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${code})::bigint)`;
    const prior = await tx.pairing.findUnique({
      where: { code },
      select: { agentTokenId: true, userId: true },
    });
    // 재승인(같은 code 로 다시 승인)이면 구 토큰을 먼저 무력화 — 고아 유효 토큰 방지
    if (prior?.agentTokenId) {
      await tx.agentToken.update({ where: { id: prior.agentTokenId }, data: { revokedAt: new Date() } });
    }
    /* 구 멤버십도 같이 내린다. 토큰만 회수하면 그 에이전트의 시스템 User·멤버십은
       `active` 로 남아, 같은 머신을 몇 번 페어링할수록 **쓸 수 없는 토큰을 가진
       팀원**이 멤버 목록에 쌓인다(담당자 드롭다운·멘션에도 그대로 뜬다).
       `/api/agent-tokens/<id>` DELETE(회수)와 같은 처리 — status="removed". */
    if (prior?.userId) {
      await tx.workspaceMember.updateMany({
        where: { workspaceId: guard.workspaceId, userId: prior.userId },
        data: { status: "removed" },
      });
    }
    // 시스템 User → 토큰 → 이메일을 토큰 id 기반으로 확정 → 멤버십(일급 팀원 노출) — agent-tokens POST 와 동일 패턴
    const user = await tx.user.create({
      data: { email: `pending-${hashToken(token).slice(0, 24)}@agents.teamspace.local`, name },
      select: { id: true },
    });
    const t = await tx.agentToken.create({
      // issuedById = 승인한 사람 — Pairing.userId 는 에이전트 시스템 User 라 발급자를 따로 남긴다(개인 레슨 기준).
      data: { workspaceId: guard.workspaceId, userId: user.id, issuedById: viewerPersonId(guard), name, role: "editor", tokenHash: hashToken(token) },
    });
    await tx.user.update({ where: { id: user.id }, data: { email: agentEmail(t.id) } });
    await tx.workspaceMember.create({
      data: { workspaceId: guard.workspaceId, userId: user.id, role: "editor", status: "active" },
    });
    await tx.pairing.upsert({
      where: { code },
      create: { code, workspaceId: guard.workspaceId, userId: user.id, agentTokenId: t.id, token },
      update: {
        workspaceId: guard.workspaceId,
        userId: user.id,
        agentTokenId: t.id,
        token,
        tokenDeliveredAt: null,
        createdAt: new Date(),
      },
    });
  });
  return NextResponse.json({ ok: true });
}

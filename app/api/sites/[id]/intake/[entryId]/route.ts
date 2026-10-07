import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx, type Ctx } from "@/lib/workspace";
import { isBootstrapCtx } from "@/lib/bootstrapCtx";
import { recordActivity } from "@/lib/activity";
import { decryptIntake } from "@/lib/sites/intakeCrypto";
import type { IntakeField } from "@/lib/sites/intake";

export const runtime = "nodejs";

/* GET    /api/sites/[id]/intake/[entryId] → 복호화한 값 한 건. **열람 기록을 남긴다**
          (활동 로그 + revealCount·lastRevealedAt).
   DELETE /api/sites/[id]/intake/[entryId] → 삭제. 값을 진짜 있어야 할 곳(비밀번호 관리자 등)으로
          옮긴 뒤 여기서 지우는 것이 정상 흐름이다.

   권한은 **admin**. 이 레포에서 editor 는 "허용 도메인 사용자가 로그인만 하면 자동으로 받는"
   기본 역할이라(lib/workspace 의 자동 가입), 남의 회사 계정 비밀번호·2FA 백업코드를 거기 걸 수 없다.
   에이전트 토큰이 admin 인 것과도 균형이 맞는다(lib/authz 의 "관리 = admin" 규칙).

   AUTH_OPEN_API=true 부트스트랩 ctx 는 거절한다 — 그 플래그가 켜진 서버에서는 세션 없이
   누구나 admin 이기 때문이다. (프록시를 타고 들어온 요청은 requireCtx 가 이미 끊는다.) */

type Params = { params: Promise<{ id: string; entryId: string }> };
const notFound = () => NextResponse.json({ error: "항목을 찾을 수 없습니다." }, { status: 404 });
const NO_STORE = { "cache-control": "no-store" } as const;

/** 활동 로그 verb 에 게스트 자유 입력을 그대로 넣지 않는다(줄바꿈으로 피드 위조 방지). */
const forLog = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);

/** AUTH_OPEN_API=true 로 세션 없이 얻은 admin 인가 — 자격 증명은 그 위에서 열지 않는다. */
function bootstrapBlocked(ctx: Ctx): NextResponse | null {
  if (!isBootstrapCtx(ctx)) return null;
  return NextResponse.json(
    { error: "AUTH_OPEN_API=true 인 서버에서는 계정 정보를 열 수 없습니다. 로그인 세션이나 에이전트 토큰으로 접근하세요." },
    { status: 403, headers: NO_STORE },
  );
}

async function load(id: string, entryId: string, workspaceId: string) {
  const site = await prisma.publishedSite.findFirst({
    where: { id, workspaceId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!site) return null;
  // siteId 스코프가 핵심이다 — 빼면 워크스페이스 A 의 admin 이 자기 사이트 id + 남의 entryId 로
  // 다른 워크스페이스의 자격 증명을 읽는다. 테스트가 이 where 절을 고정한다.
  const entry = await prisma.siteIntakeEntry.findFirst({
    where: { id: entryId, siteId: site.id },
    select: { id: true, service: true, fieldCount: true, secret: true, submittedBy: true, submittedByMember: true, createdAt: true, revealCount: true },
  });
  return entry ? { site, entry } : null;
}

export async function GET(_req: Request, { params }: Params) {
  const ctx = await requireCtx("admin");
  if ("err" in ctx) return ctx.err;
  const blocked = bootstrapBlocked(ctx);
  if (blocked) return blocked;
  const { id, entryId } = await params;
  const found = await load(id, entryId, ctx.workspaceId);
  if (!found) return notFound();
  const { site, entry } = found;

  let fields: IntakeField[];
  try {
    fields = JSON.parse(
      decryptIntake(entry.secret, { siteId: site.id, submittedBy: entry.submittedBy, service: entry.service }),
    ) as IntakeField[];
  } catch {
    // 키가 바뀌었거나 암호문이 상했거나, 암호문이 다른 행에서 옮겨졌다(AAD 불일치).
    // 원인 문자열은 키·암호문을 흘릴 수 있으니 싣지 않는다.
    return NextResponse.json(
      { error: "복호화에 실패했습니다. SITE_INTAKE_KEY 가 제출 당시와 같은지 확인하세요." },
      { status: 409, headers: NO_STORE },
    );
  }

  const updated = await prisma.siteIntakeEntry.update({
    where: { id: entry.id },
    data: { revealCount: { increment: 1 }, lastRevealedAt: new Date() },
    select: { revealCount: true, lastRevealedAt: true },
  });
  recordActivity(ctx, `받은 계정 정보를 열람함(${forLog(entry.service)})`, "site", site.title, site.id);

  // 평문 비밀번호가 실린 응답이다 — 어떤 캐시 계층에도 남기지 않는다.
  return NextResponse.json(
    {
      entry: {
        id: entry.id,
        service: entry.service,
        fieldCount: entry.fieldCount,
        submittedBy: entry.submittedBy,
        submittedByMember: entry.submittedByMember,
        createdAt: entry.createdAt,
        revealCount: updated.revealCount,
        lastRevealedAt: updated.lastRevealedAt,
        fields,
      },
    },
    { headers: NO_STORE },
  );
}

export async function DELETE(_req: Request, { params }: Params) {
  const ctx = await requireCtx("admin");
  if ("err" in ctx) return ctx.err;
  const blocked = bootstrapBlocked(ctx);
  if (blocked) return blocked;
  const { id, entryId } = await params;
  const found = await load(id, entryId, ctx.workspaceId);
  if (!found) return notFound();
  await prisma.siteIntakeEntry.delete({ where: { id: found.entry.id } });
  recordActivity(ctx, `받은 계정 정보를 삭제함(${forLog(found.entry.service)})`, "site", found.site.title, found.site.id);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

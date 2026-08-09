/* =====================================================================
   projectId 참조 검증 — 한 곳에서만 정한다.

   전수조사(2026-08-07) D5: 같은 성격의 참조를 라우트마다 다르게 처리하고 있었다.
     - 400 으로 거절        : lessons POST, decisions/risks/qa 의 PATCH
     - 조용히 null 로 버림   : decisions/risks/qa 의 POST, projects 의 leadId
     - 아예 검증 안 함       : notif-rules POST, lessons PATCH, approvals

   셋 다 "없는/남의 프로젝트를 지정했다"는 같은 상황인데 결과가 제각각이었다.
   특히 **조용히 null** 이 나쁘다 — 호출자는 프로젝트를 붙였다고 믿는데 안 붙는다.
   notif-rules 는 더 나빠서, 검증 없이 저장된 projectId 가 selectRules 에서
   영원히 매칭되지 않아 **절대 발화하지 않는 알림 규칙**이 만들어졌다.

   규칙: 참조가 주어졌으면 반드시 이 워크스페이스 것이어야 하고, 아니면 400.
   해제는 빈 문자열이나 null 로 명시한다(그때만 null 이 된다).
   ===================================================================== */

import { NextResponse } from "next/server";
import { prisma } from "./prisma";

/** 검증 결과: 저장할 값이 정해졌거나(ok), 호출자에게 돌려줄 400 응답이 있다(err). */
export type RefResult = { ok: true; projectId: string | null } | { ok: false; err: NextResponse };

/**
 * 요청 body 의 projectId 를 검증한다.
 *
 * - `undefined`  → 건드리지 않음(PATCH 의 부분 수정). ok + projectId:null 대신
 *                  호출부가 `undefined` 를 구분해야 하므로 이 함수를 부르지 말 것.
 * - `null`·`""`  → 해제. ok + null
 * - 그 외        → 이 워크스페이스 소속이어야 함. 아니면 400.
 */
export async function resolveProjectRef(
  raw: string | null | undefined,
  workspaceId: string,
  label = "프로젝트",
): Promise<RefResult> {
  const id = typeof raw === "string" ? raw.trim() : raw;
  if (!id) return { ok: true, projectId: null };

  const found = await prisma.project.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) {
    return {
      ok: false,
      err: NextResponse.json({ error: `${label}를 찾을 수 없습니다.`, projectId: id }, { status: 400 }),
    };
  }
  return { ok: true, projectId: found.id };
}

/**
 * 멤버 참조(프로젝트 리드·담당자) 검증. projects.leadId 가 조용히 버려지던 것과 같은 부류.
 * 활성 멤버만 인정한다 — 제거된 멤버를 리드로 앉히면 화면에 유령이 남는다.
 */
export async function resolveMemberRef(
  raw: string | null | undefined,
  workspaceId: string,
  label = "담당자",
): Promise<{ ok: true; userId: string | null } | { ok: false; err: NextResponse }> {
  const id = typeof raw === "string" ? raw.trim() : raw;
  if (!id) return { ok: true, userId: null };

  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId: id, status: "active" },
    select: { userId: true },
  });
  if (!member) {
    return {
      ok: false,
      err: NextResponse.json({ error: `${label}를 찾을 수 없습니다(이 워크스페이스의 활성 멤버여야 합니다).`, userId: id }, { status: 400 }),
    };
  }
  return { ok: true, userId: member.userId };
}

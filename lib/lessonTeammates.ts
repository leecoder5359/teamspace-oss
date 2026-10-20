/* 레슨 목록 보강 — 팀원 탭(작성자 이름·내가 가져왔는지), 내 탭(어디서 가져왔는지). 권한 판정은 lib/lessonAccess. */
import { prisma } from "@/lib/prisma";

export type MemberLite = { userId: string; name: string };

const displayName = (u: { name: string | null; email: string }) => u.name?.trim() || u.email.split("@")[0];

/** 워크스페이스 활성 멤버(작성자 표시 이름 = name ?? email 앞부분). 빠진 멤버의 공개 레슨은 팀원 탭에서 숨긴다(스펙 §7). */
export async function activeMembers(workspaceId: string): Promise<MemberLite[]> {
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId, status: "active" },
    select: { userId: true, user: { select: { name: true, email: true } } },
  });
  return rows.map((r) => ({ userId: r.userId, name: displayName(r.user) }));
}

/** 팀원 탭 행에 author·copiedId(내가 이미 가져온 복사본 id, 없으면 null)를 붙인다. */
export async function attachTeammateMeta<T extends { id: string; userId?: string | null }>(
  workspaceId: string,
  personId: string,
  lessons: T[],
  members: MemberLite[],
): Promise<(T & { author: { id: string; name: string }; copiedId: string | null })[]> {
  const names = new Map(members.map((m) => [m.userId, m.name]));
  const mine = lessons.length
    ? await prisma.lesson.findMany({
        where: { workspaceId, userId: personId, copiedFromId: { in: lessons.map((l) => l.id) } },
        select: { id: true, copiedFromId: true },
      })
    : [];
  const copied = new Map(mine.map((c) => [c.copiedFromId as string, c.id]));
  return lessons.map((l) => ({
    ...l,
    author: { id: l.userId as string, name: names.get(l.userId as string) ?? "알 수 없음" },
    copiedId: copied.get(l.id) ?? null,
  }));
}

/** 내 탭 행에 copiedFrom 을 붙인다 — 원본이 있으면 작성자 이름, 지워졌으면 deleted:true(이름 없이 "원본 삭제됨"). */
export async function attachCopiedFrom<T extends { copiedFromId?: string | null }>(
  workspaceId: string,
  lessons: T[],
): Promise<(T & { copiedFrom: { id: string; authorName: string | null; deleted: boolean } | null })[]> {
  const ids = [...new Set(lessons.map((l) => l.copiedFromId).filter((x): x is string => !!x))];
  if (!ids.length) return lessons.map((l) => ({ ...l, copiedFrom: null }));
  const sources = await prisma.lesson.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, userId: true } });
  const authorIds = [...new Set(sources.map((s) => s.userId).filter((x): x is string => !!x))];
  const users = authorIds.length
    ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, displayName(u)]));
  const src = new Map(sources.map((s) => [s.id, s]));
  return lessons.map((l) => {
    if (!l.copiedFromId) return { ...l, copiedFrom: null };
    const s = src.get(l.copiedFromId);
    return {
      ...l,
      copiedFrom: s
        ? { id: s.id, authorName: s.userId ? (nameOf.get(s.userId) ?? null) : null, deleted: false }
        : { id: l.copiedFromId, authorName: null, deleted: true },
    };
  });
}

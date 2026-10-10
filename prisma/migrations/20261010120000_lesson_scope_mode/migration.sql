-- 레슨 범위·주입 방식 개편: 개인 범위(Lesson.userId) · 주입 방식(Lesson.mode) · 토큰 발급자(AgentToken.issuedById).
-- 모두 추가(additive)만 — 기존 행은 전역/프로젝트/스택 범위 + mode 'default' 로 그대로 동작한다.

-- AlterTable
ALTER TABLE "AgentToken" ADD COLUMN "issuedById" TEXT;

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN "userId" TEXT,
ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'default';

-- CreateIndex
CREATE INDEX "Lesson_workspaceId_userId_idx" ON "Lesson"("workspaceId", "userId");

-- Backfill: 기존 토큰의 발급자.
-- Pairing.userId 는 발급자가 아니라 **에이전트 시스템 User** 다(pair/approve 가 새로 만든 에이전트 User 를 저장)
-- — 발급한 사람을 알려 주지 못한다. 그래서 워크스페이스에 활성 사람 admin 이 정확히 1명일 때만
-- 그 사람으로 채운다(토큰 발급은 admin 전용이고, 사용 형태는 '혼자 + 에이전트 여럿').
-- 사람 admin 이 0명이거나 여럿이면 null 로 둔다 — 개인 레슨 없이 동작하고, 토큰을 재발급하면 채워진다.
UPDATE "AgentToken" t
SET "issuedById" = h."userId"
FROM (
  SELECT m."workspaceId", MIN(m."userId") AS "userId"
  FROM "WorkspaceMember" m
  JOIN "User" u ON u."id" = m."userId"
  WHERE m."status" = 'active'
    AND m."role" = 'admin'
    AND (u."email" IS NULL OR lower(u."email") NOT LIKE '%@agents.teamspace.local')
  GROUP BY m."workspaceId"
  HAVING COUNT(*) = 1
) h
WHERE t."workspaceId" = h."workspaceId"
  AND t."issuedById" IS NULL;

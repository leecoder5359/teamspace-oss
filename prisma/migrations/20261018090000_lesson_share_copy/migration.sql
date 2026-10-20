-- 레슨 공유·가져오기: 개인 레슨의 팀원 공개 여부(sharedWithTeam, 기본 공개) · 가져온 원본 id(copiedFromId, FK 없음).
-- 추가(additive)만 — 기존 행은 공개(true)·원본 없음(null)으로 그대로 동작한다. 주입 규칙은 바뀌지 않는다.

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "sharedWithTeam" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "copiedFromId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Lesson_workspaceId_userId_copiedFromId_key" ON "Lesson"("workspaceId", "userId", "copiedFromId");

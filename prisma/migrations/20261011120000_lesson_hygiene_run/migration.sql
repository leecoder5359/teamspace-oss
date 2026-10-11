-- 레슨 주간 정리 실행 기록(lib/lessonHygiene). 추가(additive)만 — 기존 테이블은 건드리지 않는다.

-- CreateTable
CREATE TABLE "LessonHygieneRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "proposal" JSONB NOT NULL,
    "signals" JSONB,
    "backup" JSONB,
    "approvalId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "appliedAt" TIMESTAMP(3),
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LessonHygieneRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LessonHygieneRun_workspaceId_weekKey_key" ON "LessonHygieneRun"("workspaceId", "weekKey");

-- CreateIndex
CREATE INDEX "LessonHygieneRun_status_idx" ON "LessonHygieneRun"("status");

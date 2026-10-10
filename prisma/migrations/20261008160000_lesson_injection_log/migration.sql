-- CreateTable
CREATE TABLE "LessonInjection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorName" TEXT,
    "cwd" TEXT,
    "projectId" TEXT,
    "via" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'compact',
    "gistIds" TEXT[],
    "titleIds" TEXT[],
    "omittedIds" TEXT[],
    "chars" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonInjection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LessonRead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LessonRead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LessonInjection_workspaceId_createdAt_idx" ON "LessonInjection"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "LessonInjection_projectId_createdAt_idx" ON "LessonInjection"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "LessonRead_workspaceId_createdAt_idx" ON "LessonRead"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "LessonRead_lessonId_idx" ON "LessonRead"("lessonId");

-- AlterTable
ALTER TABLE "WorkspaceRouteRule" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lesson_workspaceId_projectId_idx" ON "Lesson"("workspaceId", "projectId");

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('active', 'ended');

-- CreateEnum
CREATE TYPE "SessionItemKind" AS ENUM ('observation', 'summary', 'decision', 'commit', 'file_change');

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "blocks" JSONB,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Schedule" ADD COLUMN     "timezone" TEXT;

-- CreateTable
CREATE TABLE "ClaudeSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "project" TEXT,
    "cwd" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "status" "SessionStatus" NOT NULL DEFAULT 'active',
    "lastSyncedAt" TIMESTAMP(3),

    CONSTRAINT "ClaudeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionItem" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "SessionItemKind" NOT NULL,
    "body" JSONB NOT NULL DEFAULT '{}',
    "externalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceRouteRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "cwdPrefix" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "WorkspaceRouteRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClaudeSession_workspaceId_idx" ON "ClaudeSession"("workspaceId");

-- CreateIndex
CREATE INDEX "ClaudeSession_externalId_idx" ON "ClaudeSession"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaudeSession_workspaceId_externalId_key" ON "ClaudeSession"("workspaceId", "externalId");

-- CreateIndex
CREATE INDEX "SessionItem_sessionId_idx" ON "SessionItem"("sessionId");

-- CreateIndex
CREATE INDEX "WorkspaceRouteRule_workspaceId_idx" ON "WorkspaceRouteRule"("workspaceId");

-- AddForeignKey
ALTER TABLE "ClaudeSession" ADD CONSTRAINT "ClaudeSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionItem" ADD CONSTRAINT "SessionItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ClaudeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceRouteRule" ADD CONSTRAINT "WorkspaceRouteRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

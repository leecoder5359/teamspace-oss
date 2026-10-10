-- AlterTable
ALTER TABLE "ClaudeSession" ADD COLUMN     "agentName" TEXT,
ADD COLUMN     "branch" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "repo" TEXT,
ADD COLUMN     "worktreePath" TEXT;

-- CreateTable
CREATE TABLE "PushLock" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "holderUserId" TEXT,
    "holderSession" TEXT,
    "cwd" TEXT,
    "branch" TEXT,
    "note" TEXT,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushLock_workspaceId_name_key" ON "PushLock"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ClaudeSession_workspaceId_status_idx" ON "ClaudeSession"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "PushLock" ADD CONSTRAINT "PushLock_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


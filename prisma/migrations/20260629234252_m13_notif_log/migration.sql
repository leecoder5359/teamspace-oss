-- CreateTable
CREATE TABLE "NotifLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'manual',
    "state" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotifLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotifLog_workspaceId_createdAt_idx" ON "NotifLog"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "NotifLog" ADD CONSTRAINT "NotifLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

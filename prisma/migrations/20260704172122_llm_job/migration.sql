-- CreateTable
CREATE TABLE "LlmJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "callbackUrl" TEXT NOT NULL,
    "callbackSecret" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LlmJob_workspaceId_idx" ON "LlmJob"("workspaceId");

-- CreateIndex
CREATE INDEX "LlmJob_status_idx" ON "LlmJob"("status");

-- AddForeignKey
ALTER TABLE "LlmJob" ADD CONSTRAINT "LlmJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

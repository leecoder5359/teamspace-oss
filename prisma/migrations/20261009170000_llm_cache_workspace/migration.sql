-- AlterTable
ALTER TABLE "LlmCache" ADD COLUMN     "workspaceId" TEXT;

-- CreateIndex
CREATE INDEX "LlmCache_workspaceId_idx" ON "LlmCache"("workspaceId");

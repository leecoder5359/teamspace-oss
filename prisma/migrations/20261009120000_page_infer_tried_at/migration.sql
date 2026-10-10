-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "inferTriedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Page_workspaceId_inferTriedAt_idx" ON "Page"("workspaceId", "inferTriedAt");

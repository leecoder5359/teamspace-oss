-- AlterTable
ALTER TABLE "ChangelogEntry" ADD COLUMN     "projectId" TEXT;

-- CreateIndex
CREATE INDEX "ChangelogEntry_workspaceId_projectId_idx" ON "ChangelogEntry"("workspaceId", "projectId");

-- AddForeignKey
ALTER TABLE "ChangelogEntry" ADD CONSTRAINT "ChangelogEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

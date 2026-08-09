-- AlterTable
ALTER TABLE "DbRow" ADD COLUMN     "parentRowId" TEXT;

-- CreateIndex
CREATE INDEX "DbRow_parentRowId_idx" ON "DbRow"("parentRowId");

-- AddForeignKey
ALTER TABLE "DbRow" ADD CONSTRAINT "DbRow_parentRowId_fkey" FOREIGN KEY ("parentRowId") REFERENCES "DbRow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

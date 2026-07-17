-- CreateTable
CREATE TABLE "RowChecklistItem" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RowChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RowComment" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "userId" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RowComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RowChecklistItem_rowId_idx" ON "RowChecklistItem"("rowId");

-- CreateIndex
CREATE INDEX "RowComment_rowId_idx" ON "RowComment"("rowId");

-- AddForeignKey
ALTER TABLE "RowChecklistItem" ADD CONSTRAINT "RowChecklistItem_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "DbRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RowComment" ADD CONSTRAINT "RowComment_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "DbRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RowComment" ADD CONSTRAINT "RowComment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

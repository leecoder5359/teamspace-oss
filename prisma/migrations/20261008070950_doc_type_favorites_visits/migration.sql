-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('design', 'plan', 'brief', 'report', 'handoff', 'task_note', 'other');

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "docType" "DocType";

-- CreateTable
CREATE TABLE "PageFavorite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageVisit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "visitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageVisit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageFavorite_userId_position_idx" ON "PageFavorite"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "PageFavorite_userId_pageId_key" ON "PageFavorite"("userId", "pageId");

-- CreateIndex
CREATE INDEX "PageVisit_userId_visitedAt_idx" ON "PageVisit"("userId", "visitedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PageVisit_userId_pageId_key" ON "PageVisit"("userId", "pageId");

-- AddForeignKey
ALTER TABLE "PageFavorite" ADD CONSTRAINT "PageFavorite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageFavorite" ADD CONSTRAINT "PageFavorite_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageVisit" ADD CONSTRAINT "PageVisit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageVisit" ADD CONSTRAINT "PageVisit_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

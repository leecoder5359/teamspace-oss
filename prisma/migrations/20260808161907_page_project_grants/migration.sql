-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('inherit', 'restricted');

-- CreateEnum
CREATE TYPE "GrantLevel" AS ENUM ('view', 'edit');

-- AlterTable
ALTER TABLE "Page" ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'inherit';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "visibility" "Visibility" NOT NULL DEFAULT 'inherit';

-- CreateTable
CREATE TABLE "PageGrant" (
    "id" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "level" "GrantLevel" NOT NULL DEFAULT 'view',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectGrant" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "teamId" TEXT,
    "level" "GrantLevel" NOT NULL DEFAULT 'view',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageGrant_pageId_idx" ON "PageGrant"("pageId");

-- CreateIndex
CREATE UNIQUE INDEX "PageGrant_pageId_userId_key" ON "PageGrant"("pageId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "PageGrant_pageId_teamId_key" ON "PageGrant"("pageId", "teamId");

-- CreateIndex
CREATE INDEX "ProjectGrant_projectId_idx" ON "ProjectGrant"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGrant_projectId_userId_key" ON "ProjectGrant"("projectId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectGrant_projectId_teamId_key" ON "ProjectGrant"("projectId", "teamId");

-- AddForeignKey
ALTER TABLE "PageGrant" ADD CONSTRAINT "PageGrant_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "Page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageGrant" ADD CONSTRAINT "PageGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageGrant" ADD CONSTRAINT "PageGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageGrant" ADD CONSTRAINT "PageGrant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectGrant" ADD CONSTRAINT "ProjectGrant_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

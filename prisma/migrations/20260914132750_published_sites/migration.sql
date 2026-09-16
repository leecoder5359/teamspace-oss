-- CreateEnum
CREATE TYPE "SiteStatus" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "PublishedSite" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "SiteStatus" NOT NULL DEFAULT 'active',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PublishedSite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteInvite" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMP(3),

    CONSTRAINT "SiteInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteVersion" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublishedSite_slug_key" ON "PublishedSite"("slug");

-- CreateIndex
CREATE INDEX "PublishedSite_workspaceId_idx" ON "PublishedSite"("workspaceId");

-- CreateIndex
CREATE INDEX "SiteInvite_email_idx" ON "SiteInvite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "SiteInvite_siteId_email_key" ON "SiteInvite"("siteId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "SiteVersion_siteId_version_key" ON "SiteVersion"("siteId", "version");

-- AddForeignKey
ALTER TABLE "PublishedSite" ADD CONSTRAINT "PublishedSite_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedSite" ADD CONSTRAINT "PublishedSite_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishedSite" ADD CONSTRAINT "PublishedSite_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteInvite" ADD CONSTRAINT "SiteInvite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PublishedSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteVersion" ADD CONSTRAINT "SiteVersion_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PublishedSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

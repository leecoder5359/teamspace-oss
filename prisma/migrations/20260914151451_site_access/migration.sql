-- CreateTable
CREATE TABLE "SiteAccess" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "member" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteAccess_siteId_createdAt_idx" ON "SiteAccess"("siteId", "createdAt");

-- CreateIndex
CREATE INDEX "SiteAccess_siteId_email_createdAt_idx" ON "SiteAccess"("siteId", "email", "createdAt");

-- AddForeignKey
ALTER TABLE "SiteAccess" ADD CONSTRAINT "SiteAccess_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PublishedSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

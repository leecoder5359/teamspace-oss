-- CreateTable
CREATE TABLE "SiteIntakeEntry" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "fieldCount" INTEGER NOT NULL,
    "secret" TEXT NOT NULL,
    "submittedBy" TEXT NOT NULL,
    "submittedByMember" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealCount" INTEGER NOT NULL DEFAULT 0,
    "lastRevealedAt" TIMESTAMP(3),

    CONSTRAINT "SiteIntakeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteIntakeEntry_siteId_createdAt_idx" ON "SiteIntakeEntry"("siteId", "createdAt");

-- AddForeignKey
ALTER TABLE "SiteIntakeEntry" ADD CONSTRAINT "SiteIntakeEntry_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PublishedSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

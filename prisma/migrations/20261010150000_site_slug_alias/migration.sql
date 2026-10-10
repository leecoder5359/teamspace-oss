-- 퍼블리시 사이트 설명형 주소: 슬러그를 바꾸면 옛 슬러그를 별칭으로 남겨 308 으로 넘긴다.
-- 추가(additive)만 — 기존 사이트의 무작위 슬러그는 그대로 동작한다.

-- CreateTable
CREATE TABLE "SiteSlugAlias" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteSlugAlias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SiteSlugAlias_slug_key" ON "SiteSlugAlias"("slug");

-- CreateIndex
CREATE INDEX "SiteSlugAlias_siteId_idx" ON "SiteSlugAlias"("siteId");

-- AddForeignKey
ALTER TABLE "SiteSlugAlias" ADD CONSTRAINT "SiteSlugAlias_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "PublishedSite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

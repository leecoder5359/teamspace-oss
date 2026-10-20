-- 지식 그래프 캐시 세대(lib/graphLoad) — 다른 프로세스(워커)의 무효화를 웹 캐시가 알아채게. 추가만.
-- 테이블이 없거나 읽기가 실패하면 웹은 '모름'으로 보고 예전처럼(최대 10분 낡음) 동작한다.

-- CreateTable
CREATE TABLE "GraphCacheGen" (
    "workspaceId" TEXT NOT NULL,
    "gen" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphCacheGen_pkey" PRIMARY KEY ("workspaceId")
);

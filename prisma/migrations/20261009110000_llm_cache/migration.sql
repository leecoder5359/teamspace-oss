-- CreateTable
CREATE TABLE "LlmCache" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHitAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LlmCache_key_key" ON "LlmCache"("key");

-- CreateIndex
CREATE INDEX "LlmCache_lastHitAt_idx" ON "LlmCache"("lastHitAt");

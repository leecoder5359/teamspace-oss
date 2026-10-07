-- CreateTable
CREATE TABLE "GraphEdge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'related',
    "tag" TEXT NOT NULL DEFAULT '모호',
    "reason" TEXT,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GraphEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GraphEdge_workspaceId_idx" ON "GraphEdge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphEdge_fromId_toId_kind_key" ON "GraphEdge"("fromId", "toId", "kind");

-- AddForeignKey
ALTER TABLE "GraphEdge" ADD CONSTRAINT "GraphEdge_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


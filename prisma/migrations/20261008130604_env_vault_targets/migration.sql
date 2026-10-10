-- AlterTable
ALTER TABLE "EnvAccessLog" ADD COLUMN     "targetId" TEXT;

-- AlterTable
ALTER TABLE "EnvOp" ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "targetId" TEXT;

-- CreateTable
CREATE TABLE "EnvTarget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "account" JSONB NOT NULL DEFAULT '{}',
    "lastPushedAt" TIMESTAMP(3),
    "lastPushed" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnvTarget_workspaceId_idx" ON "EnvTarget"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvTarget_projectId_env_kind_identity_key" ON "EnvTarget"("projectId", "env", "kind", "identity");

-- CreateIndex
CREATE INDEX "EnvOp_targetId_idx" ON "EnvOp"("targetId");

-- AddForeignKey
ALTER TABLE "EnvOp" ADD CONSTRAINT "EnvOp_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "EnvTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvTarget" ADD CONSTRAINT "EnvTarget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvTarget" ADD CONSTRAINT "EnvTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "EnvVar" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sealed" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "valueLength" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "syncGroup" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvVar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvVarVersion" (
    "id" TEXT NOT NULL,
    "varId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sealed" TEXT NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvVarVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvOp" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "env" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'import',
    "mode" TEXT NOT NULL DEFAULT 'merge',
    "sealedPayload" TEXT,
    "keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "approvalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "EnvOp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvAccessLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "env" TEXT,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "viaFunnel" BOOLEAN NOT NULL DEFAULT false,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnvVar_workspaceId_idx" ON "EnvVar"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvVar_projectId_env_key_key" ON "EnvVar"("projectId", "env", "key");

-- CreateIndex
CREATE INDEX "EnvVarVersion_varId_idx" ON "EnvVarVersion"("varId");

-- CreateIndex
CREATE INDEX "EnvOp_workspaceId_idx" ON "EnvOp"("workspaceId");

-- CreateIndex
CREATE INDEX "EnvOp_approvalId_idx" ON "EnvOp"("approvalId");

-- CreateIndex
CREATE INDEX "EnvAccessLog_workspaceId_at_idx" ON "EnvAccessLog"("workspaceId", "at");

-- AddForeignKey
ALTER TABLE "EnvVar" ADD CONSTRAINT "EnvVar_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvVar" ADD CONSTRAINT "EnvVar_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvVarVersion" ADD CONSTRAINT "EnvVarVersion_varId_fkey" FOREIGN KEY ("varId") REFERENCES "EnvVar"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvOp" ADD CONSTRAINT "EnvOp_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvOp" ADD CONSTRAINT "EnvOp_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvAccessLog" ADD CONSTRAINT "EnvAccessLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

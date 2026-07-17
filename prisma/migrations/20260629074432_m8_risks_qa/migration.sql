-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "RiskStatus" AS ENUM ('open', 'mitigated', 'closed');

-- CreateEnum
CREATE TYPE "QaStatus" AS ENUM ('pending', 'pass', 'fail');

-- CreateTable
CREATE TABLE "Risk" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "severity" "RiskSeverity" NOT NULL DEFAULT 'medium',
    "status" "RiskStatus" NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Risk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QaScenario" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL,
    "steps" TEXT,
    "expected" TEXT,
    "status" "QaStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QaScenario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Risk_workspaceId_idx" ON "Risk"("workspaceId");

-- CreateIndex
CREATE INDEX "Risk_projectId_idx" ON "Risk"("projectId");

-- CreateIndex
CREATE INDEX "QaScenario_workspaceId_idx" ON "QaScenario"("workspaceId");

-- CreateIndex
CREATE INDEX "QaScenario_projectId_idx" ON "QaScenario"("projectId");

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Risk" ADD CONSTRAINT "Risk_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaScenario" ADD CONSTRAINT "QaScenario_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QaScenario" ADD CONSTRAINT "QaScenario_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

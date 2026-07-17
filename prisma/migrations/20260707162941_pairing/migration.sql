-- CreateTable
CREATE TABLE "Pairing" (
    "code" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "agentTokenId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenDeliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pairing_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE INDEX "Pairing_workspaceId_idx" ON "Pairing"("workspaceId");

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pairing" ADD CONSTRAINT "Pairing_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

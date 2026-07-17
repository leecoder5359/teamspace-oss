-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('general', 'status', 'triage', 'doc', 'project', 'deploy');

-- AlterTable
ALTER TABLE "Approval" ADD COLUMN     "highRisk" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "ApprovalKind" NOT NULL DEFAULT 'general';

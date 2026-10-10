-- AlterTable
ALTER TABLE "EnvTarget" ADD COLUMN     "lastDrift" JSONB,
ADD COLUMN     "lastDriftAt" TIMESTAMP(3);

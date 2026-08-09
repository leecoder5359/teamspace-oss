-- AlterTable
ALTER TABLE "PageComment" ADD COLUMN     "anchorPrefix" TEXT,
ADD COLUMN     "anchorQuote" TEXT,
ADD COLUMN     "anchorSuffix" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT;

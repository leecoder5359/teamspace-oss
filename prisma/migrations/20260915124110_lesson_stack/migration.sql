-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "stack" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "stack" TEXT[] DEFAULT ARRAY[]::TEXT[];

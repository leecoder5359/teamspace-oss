-- 프롬프트 기반 레슨 주입(UserPromptSubmit 훅): 레슨 키워드 · 프로젝트 별칭.
-- 추가(additive)만 — 기존 행은 빈 배열로 그대로 동작한다.

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

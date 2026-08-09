-- 전문 검색 인덱스 (격차 G1)
--
-- 종전 검색은 Prisma `contains` → `ILIKE '%q%'` 였다. 선행 % 때문에 인덱스를
-- 전혀 못 타서 문서 수에 선형으로 느려졌고(이미 178건), 랭킹도 없어 제목 일치와
-- 본문 끄트머리 일치가 동급이었다.
--
-- pg_bigm 은 이 서버에 없고 pg_trgm 만 있다. 트라이그램 GIN 은 `ILIKE '%q%'` 를
-- 인덱스로 처리할 수 있고 한국어도 음절 단위로 동작한다.
--
-- ⚠️ 알려진 한계: 트라이그램은 3글자 미만 질의에서 인덱스를 못 탄다("배포" 같은
-- 2음절 검색은 여전히 순차 스캔). 라우트가 그 경우를 알고 폴백한다.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Page_title_trgm_idx"    ON "Page"    USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Page_markdown_trgm_idx" ON "Page"    USING gin (markdown gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Decision_title_trgm_idx"    ON "Decision" USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Decision_decision_trgm_idx" ON "Decision" USING gin (decision gin_trgm_ops);

-- 감사 P-12: 자주 쓰는 조회의 인덱스. 추가(additive)만.
-- CONCURRENTLY 는 쓰지 않는다 — prisma migrate 가 트랜잭션으로 돌리고, 대상 테이블이 작다.

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_status_idx" ON "WorkspaceMember"("userId", "status");

-- CreateIndex
CREATE INDEX "DbProperty_databasePageId_idx" ON "DbProperty"("databasePageId");

-- CreateIndex
CREATE INDEX "DbView_databasePageId_idx" ON "DbView"("databasePageId");

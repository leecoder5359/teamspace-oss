/* =====================================================================
   DbRow 비정규화 칸(statusOptionId·assigneeText·taskColsKey) 재계산 — 감사 P-14, 리뷰 I-2.
   읽기 쪽은 '키가 맞으면 칸을 믿는다'. 새 코드를 거치지 않은 props 쓰기(배포 롤백 구간의 옛 바이너리·수동 SQL·
   이 코드가 없는 사본)는 키는 그대로 두고 칸만 낡게 만들 수 있어, 배포마다 이걸 돌려 바로잡는다.
   SQL 은 마이그레이션과 같은 문자열(lib/taskColumnsSql) — 값이 이미 같은 행은 쓰지 않아 멱등이다.
     pnpm exec tsx scripts/rederive-task-columns.ts
   ===================================================================== */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { REDERIVE_TASK_COLUMNS_SQL } from "@/lib/taskColumnsSql";

async function main() {
  const t0 = Date.now();
  const changed = await prisma.$executeRawUnsafe(REDERIVE_TASK_COLUMNS_SQL);
  console.log(`태스크 칸 재계산: ${changed}행 갱신 (${Date.now() - t0}ms)`);
}

main()
  .catch((e) => {
    console.error("태스크 칸 재계산 실패:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

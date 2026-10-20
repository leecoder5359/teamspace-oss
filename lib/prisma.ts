import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { poolConfigFromEnv } from "./prismaPool";

// Prisma 7: 드라이버 어댑터 필수. 풀 크기·유휴 시간은 DATABASE_POOL_MAX·DATABASE_POOL_IDLE_MS(없으면 pg 기본값).
const adapter = new PrismaPg(poolConfigFromEnv(process.env));

// dev에서 HMR 시 커넥션 폭증 방지용 싱글톤
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

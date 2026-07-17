import { PrismaClient } from "@/app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7: 드라이버 어댑터 필수
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

// dev에서 HMR 시 커넥션 폭증 방지용 싱글톤
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

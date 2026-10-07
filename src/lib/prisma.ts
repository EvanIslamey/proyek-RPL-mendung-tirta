import { PrismaClient } from "../../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Singleton PrismaClient untuk aplikasi Next.js.
 * - Adapter PrismaPg diambil dari DATABASE_URL (Prisma ORM v7 wajib driver adapter).
 * - Instance dibungkus globalThis agar hot-reload dev tidak membuat
 *   banyak connection pool.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  // Batasi connection pool (default pg.Pool = 10) agar selalu di bawah
  // maxConnections server DB (PGlite lokal = 8; produksi pakai PostgreSQL
  // dengan kapasitas lebih besar — sesuaikan bila perlu).
  // idleTimeoutMillis: koneksi idle segera dilepas sehingga tidak pernah
  // "setengah mati" saat server DB lokal memutus koneksi idle — query pertama
  // setelah jeda sempat gagal 500 sebelum perbaikan ini.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

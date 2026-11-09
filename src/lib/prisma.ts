import { PrismaClient } from "../../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { invalidateAiCache } from "./ai-cache";

/**
 * Singleton PrismaClient untuk aplikasi Next.js.
 * - Adapter PrismaPg diambil dari DATABASE_URL (Prisma ORM v7 wajib driver adapter).
 * - Instance dibungkus globalThis agar hot-reload dev tidak membuat
 *   banyak connection pool.
 * - Setiap operasi TULIS ke model yang memengaruhi jawaban chatbot
 *   (produk/pesanan/ulasan/toko/kategori/user) otomatis membuang cache
 *   chatbot (ai-cache) — jawaban tidak pernah menyajikan data basi
 *   setelah ada perubahan (TTL 30 dtk hanya jaring pengaman terakhir).
 */

/** Operasi tulis yang membuat data chatbot berubah. */
const WRITE_OPERATIONS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

function createClient() {
  // Batasi connection pool (default pg.Pool = 10) agar selalu di bawah
  // maxConnections server DB (PGlite lokal = 8; produksi pakai PostgreSQL
  // dengan kapasitas lebih besar — sesuaikan bila perlu).
  // idleTimeoutMillis: koneksi idle segera dilepas sehingga tidak pernah
  // "setengah mati" saat server DB lokal memutuskan koneksi idle — query pertama
  // setelah jeda sempat gagal 500 sebelum perbaikan ini.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 6,
    idleTimeoutMillis: 30_000,
  });
  return new PrismaClient({ adapter });
}

function extendClient(client: PrismaClient) {
  return client.$extends({
    query: {
      $allOperations({ operation, args, query }) {
        if (WRITE_OPERATIONS.has(operation)) {
          invalidateAiCache();
        }
        return query(args);
      },
    },
  });
}

type ExtendedPrisma = ReturnType<typeof extendClient>;

const globalForPrisma = globalThis as unknown as { prisma?: ExtendedPrisma };

const client: ExtendedPrisma = globalForPrisma.prisma ?? extendClient(createClient());

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = client;
}

/**
 * Runtime = client hasil $extends (invalidasi cache chatbot otomatis pada
 * operasi tulis). Tipe diekspor sebagai PrismaClient murni agar kompatibel
 * dengan pemakaian lama di seluruh codebase (Prisma.TransactionClient,
 * helper bertipe tx, dll.) — extension tidak menambah API apa pun, hanya
 * mengamati operasi.
 */
export const prisma = client as unknown as PrismaClient;

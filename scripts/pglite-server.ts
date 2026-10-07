/**
 * Server database lokal untuk pengembangan & pengujian.
 *
 * Mesin ini tidak memiliki PostgreSQL yang terpasang, jadi kita menjalankan
 * PGlite (Postgres WASM) sebagai server socket TCP:
 *   - Port 55432 : database utama (DATABASE_URL)
 *   - Port 55433 : shadow database (untuk `prisma migrate dev`)
 *
 * Protokol yang dispeak standar PostgreSQL wire protocol, sehingga Prisma CLI
 * (migrate/seed/studio) dan aplikasi (@prisma/adapter-pg) bisa terkoneksi
 * tanpa memasang PostgreSQL ke sistem.
 *
 * Jalankan: npm run db:server   (biarkan berjalan di terminal terpisah)
 * Data persisten disimpan di folder .pglite/ (sudah masuk .gitignore).
 */
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const MAIN_PORT = Number(process.env.PGLITE_PORT ?? 55432);
const SHADOW_PORT = Number(process.env.PGLITE_SHADOW_PORT ?? 55433);
const dataRoot = path.join(__dirname, "..", ".pglite");

async function start(name: string, port: number) {
  const dir = path.join(dataRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(dir);
  // maxConnections default hanya 1 — `prisma migrate dev` membutuhkan
  // beberapa koneksi bersamaan (main + shadow), jadi kita naikkan.
  const debug = process.env.PGLITE_DEBUG === "1";
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1", maxConnections: 8, debug });
  await server.start();
  console.log(`[pglite] ${name} -> 127.0.0.1:${port}`);
  return { db, server };
}

async function main() {
  const mainDb = await start("main", MAIN_PORT);
  const shadowDb = await start("shadow", SHADOW_PORT);

  const shutdown = async () => {
    await mainDb.server.stop();
    await mainDb.db.close();
    await shadowDb.server.stop();
    await shadowDb.db.close();
    console.log("[pglite] stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[pglite] ready. Jalankan `npx prisma migrate dev` / `npx prisma db seed` di terminal lain.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

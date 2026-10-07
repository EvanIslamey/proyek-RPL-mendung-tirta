import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma ORM v7 memindahkan konfigurasi datasource & seed dari
// package.json / schema.prisma ke file prisma.config.ts ini.
// `process.env` dipakai langsung (bukan helper `env()`) agar perintah
// seperti `prisma generate` tetap bisa jalan tanpa DATABASE_URL (mis. CI).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});

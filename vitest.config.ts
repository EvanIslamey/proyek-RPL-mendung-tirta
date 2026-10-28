import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Konfigurasi unit test (vitest).
 * - Alias `@` → src (sama dengan tsconfig paths).
 * - DATABASE_URL dummy hanya agar modul yang meng-import prisma.ts tidak
 *   error saat import; test unit TIDAK pernah menjalankan query.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgresql://postgres@127.0.0.1:55999/mendung_tirta_test",
      // Kunci enkripsi untuk test integrasi (nilai hanya untuk unit test, bukan produksi).
      SECRET_ENCRYPTION_KEY: "kunci-tes-vitest-bukan-produksi-abcdef123456",
    },
  },
});

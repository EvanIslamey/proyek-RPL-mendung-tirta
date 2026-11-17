/**
 * Inspeksi AMAN state IntegrationConfig — hanya metadata non-rahasia.
 * Tidak pernah mencetak credentialEnc / nilai secret.
 * Usage: npx tsx scripts/inspect-config.mts
 */
import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 4 });
const prisma = new PrismaClient({ adapter });

async function main() {
  const rows = await prisma.integrationConfig.findMany({
    select: {
      id: true,
      service: true,
      scope: true,
      provider: true,
      endpoint: true,
      model: true,
      isActive: true,
      credentialHint: true,
      lastTestAt: true,
      lastTestOk: true,
      lastTestNote: true,
      updatedAt: true,
      meta: true,
    },
    orderBy: [{ service: "asc" }, { scope: "asc" }],
  });

  console.log(`Jumlah konfigurasi tersimpan: ${rows.length}`);
  for (const r of rows) {
    console.log(
      [
        `- ${r.service} scope=${r.scope || "(global)"}`,
        `provider=${r.provider}`,
        `endpoint=${r.endpoint ?? "-"}`,
        `model=${r.model ?? "-"}`,
        `active=${r.isActive}`,
        `hint=${r.credentialHint ?? "-"}`,
        `lastTest=${r.lastTestAt ? r.lastTestAt.toISOString() : "-"} ok=${r.lastTestOk ?? "-"}`,
        `note=${(r.lastTestNote ?? "-").slice(0, 120)}`,
        `meta=${r.meta ?? "-"}`,
        `updatedAt=${r.updatedAt.toISOString()}`,
      ].join(" | "),
    );
  }

  // Env AI (tanpa nilai key)
  console.log("\nEnv AI:");
  console.log(`- AI_BASE_URL=${process.env.AI_BASE_URL ?? "(kosong)"}`);
  console.log(`- AI_MODEL=${process.env.AI_MODEL ?? "(kosong)"}`);
  console.log(`- GEMINI_API_KEY=${process.env.GEMINI_API_KEY ? `<ada, panjang ${process.env.GEMINI_API_KEY.length}>` : "(kosong)"}`);
  console.log(`- AI_API_KEY=${process.env.AI_API_KEY ? `<ada, panjang ${process.env.AI_API_KEY.length}>` : "(kosong)"} (alias lama)`);
}

main()
  .catch((e) => {
    console.error("GAGAL:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Verifikasi AMAN konfigurasi Google Gemini (API native v1beta) dari env.
 * - TIDAK PERNAH mencetak API key (hanya panjang/boolean).
 * - Cek 1: GET {base}/models (header x-goog-api-key) → model tersedia di akun?
 * - Cek 2: POST {base}/models/{model}:generateContent → bukti key diterima
 *          provider & model menjawab nyata.
 *
 * Usage: npx tsx scripts/verify-gemini.mts
 */
import "dotenv/config";

const base = (process.env.AI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta").replace(
  /\/+$/,
  "",
);
const key = process.env.GEMINI_API_KEY?.trim() || process.env.AI_API_KEY?.trim() || "";
const model = (process.env.AI_MODEL?.trim() || "gemini-3.5-flash").replace(/^models\//, "");

function fail(msg: string): never {
  console.error(`GAGAL: ${msg}`);
  process.exit(1);
}

if (!key) fail("GEMINI_API_KEY kosong di .env");

console.log(`Endpoint : ${base}`);
console.log(`Model    : ${model}`);
console.log(`API key  : <ada, panjang ${key.length}> (nilai tidak ditampilkan)`);

/** Samarkan token panjang apa pun dari pesan error provider. */
const mask = (s: string) => s.replace(/[A-Za-z0-9_.-]{12,}/g, "[rahasia]").slice(0, 200);

async function main() {
  // --- 1. Ketersediaan model di akun (katalog native: models[].name) ---
  const modelsRes = await fetch(`${base}/models`, {
    headers: { "x-goog-api-key": key },
    signal: AbortSignal.timeout(30_000),
  }).catch((e: unknown) => fail(`GET /models gagal: ${e instanceof Error ? e.message : e}`));

  const payload = (await modelsRes.json().catch(() => null)) as
    | { models?: Array<{ name?: string }>; error?: { message?: string } }
    | null;
  const ids = Array.isArray(payload?.models)
    ? payload.models.map((m) => String(m.name ?? "").replace(/^models\//, "")).filter(Boolean)
    : [];
  const errNote = payload?.error?.message ? mask(payload.error.message) : "";
  console.log(`\n[1] GET /models → HTTP ${modelsRes.status}, ${ids.length} model terdaftar`);
  if (errNote && modelsRes.status !== 200) console.log(`    Pesan error provider: ${errNote}`);
  const modelAvailable = ids.includes(model);
  console.log(`    Model "${model}" tersedia di daftar: ${modelAvailable ? "YA" : "TIDAK"}`);
  if (!modelAvailable && ids.length > 0) {
    console.log(`    (contoh id yang terlihat: ${ids.slice(0, 5).join(", ")}…)`);
  }

  // --- 2. Permintaan generateContent nyata (bukti key diterima) ---
  const genRes = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Balas satu kata: siap" }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 512 },
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e: unknown) => {
    console.log(`\n[2] POST :generateContent → GAGAL jaringan: ${e instanceof Error ? e.message : e}`);
    return null;
  });

  if (!genRes) fail("Permintaan generateContent tidak sampai ke provider.");

  const gen = (await genRes.json().catch(() => null)) as
    | {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        error?: { message?: string; status?: string };
      }
    | null;
  const reply = (gen?.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? "")
    .join("");
  const genErr = gen?.error?.message ? mask(gen.error.message) : "";

  console.log(`\n[2] POST :generateContent → HTTP ${genRes.status}`);
  console.log(
    `    finishReason=${gen?.candidates?.[0]?.finishReason ?? "-"} contentChars=${reply.length}`,
  );
  console.log(`    Balasan model: ${reply ? JSON.stringify(reply.slice(0, 80)) : "(kosong)"}`);
  if (genErr) console.log(`    Pesan error provider: ${genErr}`);

  const chatOk = genRes.status === 200 && reply.trim().length > 0;
  console.log(`\nKESIMPULAN:`);
  console.log(`  - Key diterima provider (generateContent 200 + balasan): ${chatOk ? "YA" : "TIDAK"}`);
  console.log(`  - Model tersedia di akun: ${modelAvailable ? "YA" : "TIDAK"}`);
  if (!chatOk || !modelAvailable) process.exit(2);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));

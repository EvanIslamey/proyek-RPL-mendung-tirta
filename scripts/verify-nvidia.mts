/**
 * Verifikasi AMAN konfigurasi NVIDIA NIM dari environment variable.
 * - TIDAK PERNAH mencetak API key (hanya panjang/boolean).
 * - Cek 1: GET {base}/models → apakah model terkonfigurasi tersedia di akun.
 * - Cek 2: POST {base}/chat/completions → bukti key diterima provider
 *          (GET /models NVIDIA bisa 200 utk key invalid — status 200 bukan bukti).
 *
 * Usage: npx tsx scripts/verify-nvidia.mts
 */
import "dotenv/config";

const base = (process.env.AI_BASE_URL?.trim() || "").replace(/\/+$/, "");
const key = process.env.AI_API_KEY?.trim() || "";
const model = process.env.AI_MODEL?.trim() || "";

function fail(msg: string): never {
  console.error(`GAGAL: ${msg}`);
  process.exit(1);
}

if (!base) fail("AI_BASE_URL kosong di .env");
if (!key) fail("AI_API_KEY kosong di .env");
if (!model) fail("AI_MODEL kosong di .env");

console.log(`Endpoint : ${base}`);
console.log(`Model    : ${model}`);
console.log(`API key  : <ada, panjang ${key.length}> (nilai tidak ditampilkan)`);

async function main() {
  // --- 1. Ketersediaan model di akun ---
  const modelsRes = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  }).catch((e: unknown) => fail(`GET /models gagal: ${e instanceof Error ? e.message : e}`));

  const payload = (await modelsRes.json().catch(() => null)) as
    | { data?: Array<{ id?: string }> }
    | null;
  const ids = Array.isArray(payload?.data)
    ? payload.data.map((m) => String(m.id ?? "")).filter(Boolean)
    : [];
  console.log(`\n[1] GET /models → HTTP ${modelsRes.status}, ${ids.length} model terdaftar`);
  const modelAvailable = ids.includes(model);
  console.log(`    Model "${model}" tersedia di daftar: ${modelAvailable ? "YA" : "TIDAK"}`);
  if (!modelAvailable && ids.length > 0) {
    console.log(`    (contoh id yang terlihat: ${ids.slice(0, 5).join(", ")}…)`);
  }

  // --- 2. Permintaan chat nyata (bukti key diterima) ---
  const chatRes = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Balas satu kata: siap" }],
      max_tokens: 500,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch((e: unknown) => {
    console.log(`\n[2] POST /chat/completions → GAGAL jaringan: ${e instanceof Error ? e.message : e}`);
    return null;
  });

  if (!chatRes) fail("Permintaan chat tidak sampai ke provider.");

  const chat = (await chatRes.json().catch(() => null)) as
    | {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; reasoning?: string; reasoning_content?: string };
        }>;
        error?: { message?: string };
      }
    | null;
  const choice = chat?.choices?.[0];
  const reply = choice?.message?.content ?? "";
  const reasoningLen = (choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? "").length;
  const errNote = chat?.error?.message
    ? chat.error.message.replace(/[A-Za-z0-9_.-]{12,}/g, "[rahasia]").slice(0, 160)
    : "";

  console.log(`\n[2] POST /chat/completions → HTTP ${chatRes.status}`);
  console.log(
    `    finish_reason=${choice?.finish_reason ?? "-"} reasoningChars=${reasoningLen} contentChars=${reply.length}`,
  );
  console.log(`    Balasan model: ${reply ? JSON.stringify(reply.slice(0, 80)) : "(kosong)"}`);
  if (errNote) console.log(`    Pesan error provider: ${errNote}`);

  const chatOk = chatRes.status === 200 && reply.trim().length > 0;
  console.log(`\nKESIMPULAN:`);
  console.log(`  - Key diterima provider (chat 200 + balasan): ${chatOk ? "YA" : "TIDAK"}`);
  console.log(`  - Model tersedia di akun: ${modelAvailable ? "YA" : "TIDAK"}`);
  if (!chatOk || !modelAvailable) process.exit(2);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));

/**
 * Verifikasi E2E: konfigurasi AI AKTIF di DB benar-benar dipakai chatbot backend.
 *
 * Strategi: jalankan mock provider AI lokal, simpan konfigurasi AI yang menunjuk
 * ke mock (credential palsu khusus uji), aktifkan setelah mock-nya "lolos uji",
 * lalu kirim pesan chatbot. Bila jawaban berasal dari mock DAN header
 * Authorization memakai credential dari DB (bukan env), terbukti resolver
 * memprioritaskan DB. Semua data uji dibersihkan di akhir.
 *
 * Jalankan terhadap dev server yang hidup:
 *   1. npm run db:server   (terminal 1)
 *   2. npm run dev         (terminal 2)
 *   3. npx tsx scripts/verify-db-ai-config.mts
 */
import http from "node:http";
import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";
import {
  deleteIntegrationConfig,
  resolveAiRuntime,
  runAiTest,
  saveIntegrationConfig,
  setIntegrationActive,
} from "../src/lib/integrations";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
const DB_KEY = "db-key-live-verifikasi-1234567890"; // credential uji, bukan rahasia nyata

type Check = { name: string; pass: boolean; detail?: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail?: string) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} — ${name}${!pass && detail ? ` (${detail})` : ""}`);
}

async function api(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return { status: res.status, json: json as Record<string, unknown> | null, text, setCookie };
}

function sessionCookie(setCookie: string[]): string | null {
  const raw = setCookie.find((c) => c.startsWith("mt_session="));
  if (!raw) return null;
  const pair = raw.split(";")[0];
  return pair && !pair.endsWith("=") ? pair : null;
}

async function main() {
  // --- Mock provider AI lokal: /models (untuk uji) + /chat/completions (untuk chat) ---
  let chatAuth: string | null = null; // auth yang diterima di /chat/completions saja
  const mock = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? null;
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/models")) {
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      chatAuth = auth;
      req.resume(); // buang body permintaan (mock tidak membacanya)
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Jawaban dari mock DB." } }],
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const port = (mock.address() as { port: number }).port;
  const mockBase = `http://127.0.0.1:${port}/v1`;

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  try {
    // --- 1. Simpan konfigurasi AI menunjuk ke mock (credential uji) ---
    const row = await saveIntegrationConfig({
      service: "AI_PROVIDER",
      scope: "",
      provider: "openai-compatible",
      endpoint: mockBase,
      credential: DB_KEY,
      model: "mock-model",
      meta: { name: "Verifikasi DB" },
    });
    check("Simpan konfigurasi AI (mock provider) → tersimpan", !!row.id);

    // --- 2. Aktifkan SEBELUM uji → harus DITOLAK (belum tervalidasi) ---
    const early = await setIntegrationActive("AI_PROVIDER", "", true);
    check("Aktifkan sebelum uji → ditolak backend", !early.ok, early.message);

    // --- 3. Uji koneksi nyata ke mock → lolos → aktifkan ---
    const test = await runAiTest("");
    check("Uji koneksi ke mock provider → sukses", test.ok, test.note);
    const active = await setIntegrationActive("AI_PROVIDER", "", true);
    check("Aktifkan setelah uji lolos → diizinkan", active.ok, active.message);

    // --- 4. resolveAiRuntime memprioritaskan DB ---
    const runtime = await resolveAiRuntime();
    check(
      "resolveAiRuntime → source=db, key dari DB (bukan env)",
      runtime.source === "db" &&
        runtime.baseUrl === mockBase &&
        runtime.model === "mock-model",
      `source=${runtime.source} baseUrl=${runtime.baseUrl}`,
    );

    // --- 5. Chatbot memakai konfigurasi DB: jawaban datang dari mock ---
    const login = await api("/api/auth/login", {
      method: "POST",
      body: { email: "pembeli@mendungtirta.com", password: "password123" },
    });
    const cookie = sessionCookie(login.setCookie);
    if (!cookie) throw new Error("Gagal login pembeli.");

    const chat = await api("/api/ai/chat", {
      method: "POST",
      cookie,
      // Pesan TANPA filter subjek/harga/store — filter aktif memang sengaja
      // memakai jalur deterministik (bukan provider), jadi untuk menguji
      // pemakaian konfigurasi DB kita pakai pertanyaan yang menghasilkan
      // filters kosong (diverifikasi via scripts/debug-chat-filters.mts).
      body: { message: "Bagaimana cara membeli produk?" },
    });
    const reply = (chat.json?.reply as string | undefined) ?? "";
    check(
      "Chatbot memakai konfigurasi AKTIF di DB (jawaban dari mock)",
      chat.status === 200 &&
        reply.includes("Jawaban dari mock DB.") &&
        chat.json?.source === "ai",
      `status=${chat.status} source=${String(chat.json?.source)} reply=${reply.slice(0, 80)}`,
    );
    check(
      "Request provider memakai credential terdekripsi dari DB (bukan env)",
      chatAuth === `Bearer ${DB_KEY}`,
      `auth=${chatAuth === null ? "tidak ada di /chat/completions" : "diterima"}`,
    );

    // --- 6. Nonaktifkan → chatbot kembali ke env (fallback/ai env) ---
    await setIntegrationActive("AI_PROVIDER", "", false);
    const runtime2 = await resolveAiRuntime();
    check(
      "Setelah nonaktifkan → resolver kembali ke env",
      runtime2.source === "env",
      `source=${runtime2.source}`,
    );
  } finally {
    // --- 7. Bersihkan semua data uji ---
    await deleteIntegrationConfig("AI_PROVIDER", "");
    const left = await prisma.integrationConfig.findMany();
    check("Konfigurasi uji dibersihkan dari DB", left.length === 0, `sisa=${left.length}`);
    await prisma.$disconnect();
    mock.close();
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\n=== Ringkasan: ${checks.length - failed.length}/${checks.length} PASS, ${failed.length} FAIL ===`,
  );
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Verifikasi gagal berjalan:", e);
  process.exit(1);
});

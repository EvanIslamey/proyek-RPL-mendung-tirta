/**
 * Uji chatbot LIVE dengan konfigurasi AI (Google Gemini) dari DB/env.
 * - Login sebagai pembeli, kirim 1 permintaan sederhana ke /api/ai/chat.
 * - Cek jawaban berasal dari provider (source="ai"), bukan karangan.
 * - Cek resolveAiRuntime() memakai konfigurasi DB (tanpa mencetak key).
 *
 * Usage: npx tsx scripts/test-chatbot-live.mts
 */
import "dotenv/config";
import { resolveAiRuntime } from "../src/lib/integrations";

const BASE = process.env.APP_URL ?? "http://localhost:3000";

async function api(path: string, opts: { method?: string; body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
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
  const runtime = await resolveAiRuntime();
  console.log(
    `Runtime resolver: source=${runtime.source} baseUrl=${runtime.baseUrl} model=${runtime.model} key=${runtime.apiKey ? `<ada, panjang ${runtime.apiKey.length}>` : "(kosong)"}`,
  );
  if (runtime.source !== "db") {
    console.error("GAGAL: resolver tidak memakai konfigurasi DB.");
    process.exit(1);
  }

  const login = await api("/api/auth/login", {
    method: "POST",
    body: { email: "pembeli@mendungtirta.com", password: "password123" },
  });
  const cookie = sessionCookie(login.setCookie);
  if (!cookie) {
    console.error("GAGAL: login pembeli.");
    process.exit(1);
  }

  // Pesan tanpa filter (filter aktif sengaja memakai jalur deterministik).
  const messages = [
    "Bagaimana cara membeli produk?",
    "Siapa saya dan kapan saya mendaftar?",
  ];
  let allOk = true;
  for (const message of messages) {
    const t0 = Date.now();
    const chat = await api("/api/ai/chat", {
      method: "POST",
      cookie,
      body: { message },
    });
    const elapsed = Date.now() - t0;
    const reply = (chat.json?.reply as string | undefined) ?? "";
    const source = chat.json?.source as string | undefined;
    const sources = JSON.stringify(chat.json?.sources ?? []);
    const products = (chat.json?.products as unknown[] | undefined)?.length ?? 0;

    console.log(`\nPertanyaan: "${message}"`);
    console.log(`Chat: HTTP ${chat.status} source=${source} latency=${elapsed}ms produk=${products}`);
    console.log(`Sumber: ${sources}`);
    console.log(`Jawaban (${reply.length} karakter):`);
    console.log(reply.slice(0, 600));

    const ok = chat.status === 200 && source === "ai" && reply.trim().length > 0;
    if (!ok) allOk = false;
  }

  console.log(`\nKESIMPULAN: permintaan AI live via backend ${allOk ? "BERHASIL" : "GAGAL"}`);
  if (!allOk) process.exit(2);
}

main().catch((e: unknown) => {
  console.error("GAGAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});

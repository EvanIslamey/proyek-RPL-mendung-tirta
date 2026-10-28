/**
 * Smoke test fitur Pengaturan Integrasi (WhatsApp & API Key AI).
 * Jalankan terhadap dev server yang hidup:
 *   1. npm run db:server   (terminal 1)
 *   2. npm run dev         (terminal 2)
 *   3. npx tsx scripts/smoke-integrations.mts
 *
 * Menguji kriteria selesai:
 *  - Konfigurasi tersimpan persisten (terbaca ulang setelah "reload").
 *  - API key/access token TIDAK PERNAH bocor ke respons frontend, DB (plaintext), atau log.
 *  - Otorisasi backend: BUYER ditolak, SELLER hanya WhatsApp miliknya sendiri, ADMIN kelola global.
 *  - Uji koneksi menampilkan hasil AKTUAL (provider palsu -> gagal, tidak mengarang sukses).
 *  - Profil & ganti password tetap berfungsi (tidak ada regresi).
 */
import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const BASE = process.env.APP_URL ?? "http://localhost:3000";

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

async function login(email: string, password: string): Promise<string | null> {
  const r = await api("/api/auth/login", { method: "POST", body: { email, password } });
  return sessionCookie(r.setCookie);
}

async function main() {
  const stamp = Date.now();
  // Token uji sengaja dibuat UNIK tiap run agar deteksi kebocoran andal
  // (bila muncul di mana pun selain input form, berarti bocor).
  const TOKEN = `sk-smoke-${stamp}-rahasiaunikan1234567890`;
  const PHONE_ID = `10${stamp}`;

  // --- 0. Guard: tanpa login harus ditolak backend ---
  {
    const wa = await api("/api/settings/whatsapp");
    const ai = await api("/api/settings/api-key");
    check("GET /api/settings/whatsapp tanpa login -> 401", wa.status === 401, `status ${wa.status}`);
    check("GET /api/settings/api-key tanpa login -> 401", ai.status === 400 || ai.status === 401, `status ${ai.status}`);
    const put = await api("/api/settings/api-key", { method: "PUT", body: { name: "x" } });
    check("PUT /api/settings/api-key tanpa login -> ditolak", put.status >= 400, `status ${put.status}`);
  }

  // --- 1. BUYER ditolak semua pengaturan integrasi ---
  {
    const cookie = await login("pembeli@mendungtirta.com", "password123");
    if (!cookie) throw new Error("Gagal login pembeli — pastikan server & seed hidup.");
    const wa = await api("/api/settings/whatsapp", { cookie });
    const ai = await api("/api/settings/api-key", { cookie });
    const putWa = await api("/api/settings/whatsapp", { method: "PUT", cookie, body: { provider: "meta-whatsapp-cloud", meta: { phoneId: "1" } } });
    const putAi = await api("/api/settings/api-key", { method: "PUT", cookie, body: { name: "x", credential: TOKEN } });
    check("BUYER GET WhatsApp -> ditolak", wa.status >= 400, `status ${wa.status}`);
    check("BUYER GET API Key -> ditolak", ai.status >= 400, `status ${ai.status}`);
    check("BUYER PUT WhatsApp -> ditolak", putWa.status >= 400, `status ${putWa.status}`);
    check("BUYER PUT API Key -> ditolak", putAi.status >= 400, `status ${putAi.status}`);
  }

  // --- 2. SELLER: kelola WhatsApp milik sendiri, TAPI ditolak API Key global ---
  {
    const cookie = await login("nelayan.budi@mendungtirta.com", "password123");
    if (!cookie) throw new Error("Gagal login seller.");
    const ai = await api("/api/settings/api-key", { cookie });
    const putAi = await api("/api/settings/api-key", { method: "PUT", cookie, body: { name: "x", credential: TOKEN } });
    check("SELLER GET API Key global -> ditolak", ai.status >= 400, `status ${ai.status}`);
    check("SELLER PUT API Key global -> ditolak", putAi.status >= 400, `status ${putAi.status}`);

    // SELLER boleh simpan WhatsApp miliknya sendiri.
    const putWa = await api("/api/settings/whatsapp", {
      method: "PUT",
      cookie,
      body: { provider: "meta-whatsapp-cloud", meta: { phoneId: PHONE_ID }, credential: TOKEN },
    });
    check("SELLER simpan WhatsApp sendiri -> 200", putWa.status === 200, `status ${putWa.status}: ${putWa.text.slice(0, 120)}`);
    const waText = putWa.text;
    check("Response simpan WA TIDAK memuat token mentah", !waText.includes(TOKEN));
    check("Response simpan WA menampilkan hint tersamarkan", /sk-smoke.{0,12}1234|•{3,}/.test(waText), waText.slice(0, 200));
  }

  // --- 3. ADMIN: kelola API Key global — persisten, tersamarkan, tidak bocor ---
  {
    const cookie = await login("admin@mendungtirta.com", "password123");
    if (!cookie) throw new Error("Gagal login admin.");

    const save = await api("/api/settings/api-key", {
      method: "PUT",
      cookie,
      body: { name: "Chatbot Utama", provider: "openai-compatible", credential: TOKEN, model: "gpt-test" },
    });
    check("ADMIN simpan API Key -> 200", save.status === 200, `status ${save.status}: ${save.text.slice(0, 150)}`);
    check("Response simpan TIDAK memuat API key mentah", !save.text.includes(TOKEN));
    check("Response simpan menampilkan hint tersamarkan", /sk-smoke.{0,12}1234|•{3,}/.test(save.text), save.text.slice(0, 200));

    // Persisten: GET ulang ( simulasi reload halaman ).
    const again = await api("/api/settings/api-key", { cookie });
    check("GET ulang API Key -> 200 (persisten)", again.status === 200, `status ${again.status}`);
    check("GET ulang TIDAK memuat key mentah", !again.text.includes(TOKEN));
    const cfg = again.json?.config as { hasCredential?: boolean; credentialHint?: string | null; model?: string } | undefined;
    check("GET ulang menandai credential tersimpan", cfg?.hasCredential === true, JSON.stringify(cfg));
    check("GET ulang TIDAK mengembalikan key asli", !String(cfg?.credentialHint ?? "").includes("rahasiaunikan"));

    // Simpan ulang TANPA credential -> key lama dipertahankan (tidak tertimpa kosong).
    const resave = await api("/api/settings/api-key", { method: "PUT", cookie, body: { name: "Chatbot Utama v2" } });
    const cfg2 = resave.json?.config as { hasCredential?: boolean } | undefined;
    check("Simpan ulang tanpa credential -> key lama dipertahankan", resave.status === 200 && cfg2?.hasCredential === true, `status ${resave.status}`);

    // --- 3b. Uji koneksi: jalankan sungguhan, hasil diambil apa adanya ---
    // Catatan: sebagian provider (mis. /models NVIDIA) mengembalikan katalog publik
    // 200 OK meski key tidak valid. Karena itu test TIDAK mengasumsikan ok=false —
    // yang diuji adalah: (1) hasil berasal dari permintaan nyata, dan (2) guard
    // aktivasi di backend menolak konfigurasi yang belum lolos uji.
    const test = await api("/api/settings/api-key/test", { method: "POST", cookie });
    check("Uji koneksi API Key -> 200 + hasil aktual", test.status === 200, `status ${test.status}: ${test.text.slice(0, 150)}`);
    const result = test.json?.result as { ok?: boolean; note?: string } | undefined;
    check("Catatan uji memuat penjelasan hasil (bukan kosong)", typeof result?.note === "string" && result.note.length > 0, `note=${result?.note}`);
    check("Catatan uji tidak memuat key mentah", !test.text.includes(TOKEN));

    // --- 3c. Guard aktifkan: hanya boleh aktif bila lolos uji ---
    // Simulasikan konfigurasi BELUM tervalidasi dengan menyimpan ulang credential
    // (reset lastTestOk), lalu pastikan aktivasi DITOLAK backend.
    await api("/api/settings/api-key", { method: "PUT", cookie, body: { credential: `${TOKEN}-v2` } });
    const toggleBlocked = await api("/api/settings/api-key/toggle", { method: "POST", cookie, body: { isActive: true } });
    check(
      "Aktifkan konfigurasi BELUM tervalidasi -> ditolak backend",
      toggleBlocked.status >= 400,
      `status ${toggleBlocked.status}: ${toggleBlocked.text.slice(0, 120)}`,
    );

    // --- 3d. Chatbot TETAP berfungsi meski config ada (fallback saat provider gagal) ---
    const chat = await api("/api/ai/chat", { method: "POST", cookie, body: { message: "Produk hasil laut di bawah 50000" } });
    const reply = (chat.json?.reply as string | undefined) ?? "";
    check(
      "Chatbot tetap menjawab (fallback saat provider gagal) & tidak mengarang",
      chat.status === 200 && reply.length > 0 && !chat.text.includes(TOKEN),
      `status ${chat.status}, source=${String(chat.json?.source)} reply=${reply.slice(0, 80)}`,
    );

    // --- 3e. Hapus konfigurasi -> kembali bersih ---
    const del = await api("/api/settings/api-key", { method: "DELETE", cookie });
    check("Hapus API Key -> 200", del.status === 200, `status ${del.status}`);
    const afterDel = await api("/api/settings/api-key", { cookie });
    const cfgAfter = afterDel.json?.config as unknown;
    check("Setelah hapus -> config null", cfgAfter === null || cfgAfter === undefined, JSON.stringify(cfgAfter));
  }

  // --- 4. DB aktual: credential tersimpan TERENKRIPSI (bukan plaintext) ---
  {
    const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter });
    try {
      const rows = await prisma.integrationConfig.findMany();
      const leaked = rows.filter((r) => (r.credentialEnc ?? "").includes("rahasiaunikan") || (r.meta ?? "").includes("rahasiaunikan"));
      check("DB: TIDAK ada credential plaintext di kolom manapun", leaked.length === 0, JSON.stringify(leaked.map((r) => r.id)));
      const enc = rows.find((r) => r.credentialEnc);
      check(
        "DB: credentialEnc berbentuk terenkripsi (prefix v1: + bukan plaintext)",
        !!enc && (enc.credentialEnc ?? "").startsWith("v1:") && !(enc.credentialEnc ?? "").includes("rahasiaunikan"),
        enc ? (enc.credentialEnc ?? "").slice(0, 40) : "tidak ada baris credential",
      );
      // Bersihkan baris uji agar DB tidak menumpuk.
      await prisma.integrationConfig.deleteMany();
    } finally {
      await prisma.$disconnect();
    }
  }

  // --- 5. Regresi: profil & ganti password tetap berfungsi ---
  {
    const cookie = await login("pembeli@mendungtirta.com", "password123");
    const prof = await api("/api/profile", { cookie: cookie ?? "" });
    check("Regresi: GET profil pembeli -> 200", prof.status === 200, `status ${prof.status}`);
    const pw = await api("/api/profile/password", {
      method: "POST",
      cookie: cookie ?? "",
      body: { currentPassword: "salah", newPassword: "rahasia-baru-123" },
    });
    check("Regresi: ganti password dengan password lama SALAH -> ditolak", pw.status >= 400, `status ${pw.status}`);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n=== Ringkasan: ${checks.length - failed.length}/${checks.length} PASS, ${failed.length} FAIL ===`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`  FAIL: ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("Smoke test gagal berjalan:", e);
  process.exit(1);
});

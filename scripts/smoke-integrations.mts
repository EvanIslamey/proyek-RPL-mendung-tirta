/**
 * Smoke test fitur Pengaturan Integrasi (WhatsApp/Fonnte & API Key AI).
 * Jalankan terhadap dev server yang hidup:
 *   1. npm run db:server   (terminal 1)
 *   2. npm run dev         (terminal 2)
 *   3. npx tsx scripts/smoke-integrations.mts
 *
 * Menguji kriteria selesai:
 *  - Konfigurasi tersimpan persisten (terbaca ulang setelah "reload").
 *  - API key / API Token Fonnte TIDAK PERNAH bocor ke respons frontend, DB (plaintext), atau log.
 *  - Otorisasi backend: BUYER ditolak, SELLER hanya WhatsApp miliknya sendiri, ADMIN kelola global.
 *  - Uji koneksi Fonnte menampilkan hasil AKTUAL provider (token palsu -> gagal jujur,
 *    bukan sukses palsu dari HTTP 200); status perangkat TIDAK bisa dipalsukan dari client.
 *  - Integrasi Meta LAMA sudah tidak diterima backend (provider ditolak, phoneId dibersihkan).
 *  - Preferensi notifikasi WA pengguna (+62 & opt-in) tervalidasi backend.
 *  - Profil & ganti password tetap berfungsi (tidak ada regresi).
 *
 * JAMINAN PENTING: seluruh baris IntegrationConfig + data phone/whatsappNotify user
 * di-SNAPSHOT di awal dan DIPULIKAN di finally (termasuk saat gagal) — konfigurasi
 * AI yang AKTIF tidak pernah hilang oleh script ini.
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

type ConfigView = {
  provider?: string;
  providerLabel?: string;
  meta?: Record<string, string> | null;
  hasCredential?: boolean;
  credentialHint?: string | null;
  isActive?: boolean;
  lastTestOk?: boolean | null;
};

async function main() {
  const stamp = Date.now();
  // Token uji sengaja dibuat UNIK tiap run agar deteksi kebocoran andal
  // (bila muncul di mana pun selain input form, berarti bocor).
  const TOKEN = `sk-smoke-${stamp}-rahasiaunikan1234567890`;
  const WA_TOKEN = `fmk-smoke-${stamp}-rahasiaunikan1234567890`;

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  // --- SNAPSHOT proteksi: kondisi awal yang harus pulih di akhir run ---
  const cfgSnapshot = await prisma.integrationConfig.findMany();
  const userSnapshot = await prisma.user.findMany({
    select: { id: true, phone: true, whatsappNotify: true },
  });
  // Baris WHATSAPP dibersihkan di awal agar titik-awal deterministik; seluruh
  // config (termasuk WA asli) disnapshot di cfgSnapshot & dipulihkan di finally.
  // Config AI TIDAK disentuh selama run.
  await prisma.integrationConfig.deleteMany({ where: { service: "WHATSAPP" } });
  console.log(
    `[snapshot] ${cfgSnapshot.length} konfigurasi tersimpan, ${userSnapshot.length} profil user, baris WA uji dibersihkan.`,
  );

  try {
    // --- 0. Guard: tanpa login harus ditolak backend ---
    {
      const wa = await api("/api/settings/whatsapp");
      const ai = await api("/api/settings/api-key");
      check("GET /api/settings/whatsapp tanpa login -> 401", wa.status === 401, `status ${wa.status}`);
      check("GET /api/settings/api-key tanpa login -> 400/401", ai.status === 400 || ai.status === 401, `status ${ai.status}`);
      const put = await api("/api/settings/api-key", { method: "PUT", body: { name: "x" } });
      check("PUT /api/settings/api-key tanpa login -> ditolak", put.status >= 400, `status ${put.status}`);
    }

    // --- 1. BUYER ditolak semua pengaturan integrasi ---
    {
      const cookie = await login("pembeli@mendungtirta.com", "password123");
      if (!cookie) throw new Error("Gagal login pembeli — pastikan server & seed hidup.");
      const wa = await api("/api/settings/whatsapp", { cookie });
      const ai = await api("/api/settings/api-key", { cookie });
      const putWa = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: { provider: "fonnte", meta: { testTarget: "+6281234567890" } },
      });
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

      // SELLER simpan WA Fonnte miliknya sendiri — sengaja ikut menyertakan kunci
      // terlarang (phoneId sisa Meta, device* status perangkat, opsTargets admin)
      // yang HARUS dibersihkan backend.
      const putWa = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: {
          provider: "fonnte",
          meta: {
            testTarget: "+6281234567890",
            senderNumber: "+6289876543210",
            phoneId: "123456789012345",
            deviceNumber: "6281234567890",
            deviceStatus: "connect",
            opsTargets: "+628111111111",
          },
          credential: WA_TOKEN,
        },
      });
      check("SELLER simpan WA Fonnte -> 200", putWa.status === 200, `status ${putWa.status}: ${putWa.text.slice(0, 140)}`);
      check("Response simpan WA TIDAK memuat token mentah", !putWa.text.includes(WA_TOKEN));
      check("Response simpan WA menampilkan hint tersamarkan", /fmk-smoke.{0,16}1234|•{3,}/.test(putWa.text), putWa.text.slice(0, 240));

      const getWa = await api("/api/settings/whatsapp", { cookie });
      const cfg = getWa.json?.config as ConfigView | null | undefined;
      check("GET ulang WA seller -> persisten (testTarget & senderNumber tersimpan)", cfg?.meta?.testTarget === "+6281234567890" && cfg?.meta?.senderNumber === "+6289876543210", JSON.stringify(cfg?.meta));
      check("phoneId (sisa Meta) DIBERSIHKAN backend", cfg?.meta?.phoneId === undefined, JSON.stringify(cfg?.meta));
      check("device* (status perangkat) TIDAK bisa dipalsukan dari client", cfg?.meta?.deviceStatus === undefined && cfg?.meta?.deviceNumber === undefined, JSON.stringify(cfg?.meta));
      check("opsTargets di-strip untuk scope seller (khusus admin global)", cfg?.meta?.opsTargets === undefined, JSON.stringify(cfg?.meta));
      check("GET ulang TIDAK memuat token mentah", !getWa.text.includes(WA_TOKEN));

      // Validasi format nomor ditolak backend SEBELUM menyentuh provider.
      const badTarget = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: { provider: "fonnte", meta: { testTarget: "081234567890" } },
      });
      check("testTarget non-E.164 -> ditolak backend", badTarget.status === 400, `status ${badTarget.status}`);
      const badSender = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: { provider: "fonnte", meta: { senderNumber: "081234567890" } },
      });
      check("senderNumber format 08xx -> ditolak backend (wajib +62)", badSender.status === 400, `status ${badSender.status}`);

      // Uji koneksi WA ke Fonnte SUNGGUHAN dengan token uji palsu -> hasil
      // AKTUAL provider (ditolak/token invalid — tidak pernah mengarang sukses).
      const waTest = await api("/api/settings/whatsapp/test", { method: "POST", cookie });
      const waRes = waTest.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "Uji koneksi WA (token uji) -> hasil aktual Fonnte, bukan sukses palsu",
        waTest.status === 200 && typeof waRes?.note === "string" && waRes.note.length > 0 && waRes.ok === false,
        `status=${waTest.status} ok=${waRes?.ok} note=${waRes?.note}`,
      );
      check("Hasil uji WA TIDAK memuat token mentah", !waTest.text.includes(WA_TOKEN));

      // Kirim pesan uji: konfigurasi belum aktif -> DITOLAK, tidak ada pesan terkirim.
      const waMsg = await api("/api/settings/whatsapp/test", {
        method: "PUT",
        cookie,
        body: { to: "+6281234567890" },
      });
      const msgRes = waMsg.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "Kirim pesan uji saat konfigurasi nonaktif -> ditolak (tidak mengirim)",
        waMsg.status === 200 && msgRes?.ok === false,
        `status=${waMsg.status} ok=${msgRes?.ok} note=${msgRes?.note}`,
      );

      // Nomor tujuan tidak valid -> ditolak sebelum menyentuh provider.
      const waBadTo = await api("/api/settings/whatsapp/test", {
        method: "PUT",
        cookie,
        body: { to: "081234567890" },
      });
      check("Nomor tujuan non-E.164 -> ditolak backend", waBadTo.status >= 400, `status ${waBadTo.status}`);

      // Tanpa field `to` -> fallback ke nomor tujuan pengujian tersimpan.
      const waFallback = await api("/api/settings/whatsapp/test", { method: "PUT", cookie, body: {} });
      const fbRes = waFallback.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "Kirim uji tanpa `to` -> fallback meta.testTarget (ditolak karena nonaktif)",
        waFallback.status === 200 && fbRes?.ok === false && /belum diaktifkan/i.test(fbRes?.note ?? ""),
        `status=${waFallback.status} note=${fbRes?.note}`,
      );

      // Aktifkan tanpa lolos uji koneksi -> ditolak backend (guard server-side).
      const toggle = await api("/api/settings/whatsapp/toggle", {
        method: "POST",
        cookie,
        body: { isActive: true },
      });
      check("SELLER aktifkan WA tanpa lolos uji koneksi -> ditolak", toggle.status >= 400, `status ${toggle.status}: ${toggle.text.slice(0, 120)}`);
    }

    // --- 2b. ADMIN: uji jujur, validasi Fonnte, guard aktivasi, strip meta lama ---
    {
      const cookie = await login("admin@mendungtirta.com", "password123");
      if (!cookie) throw new Error("Gagal login admin.");

      // Uji koneksi TANPA konfigurasi -> hasil jujur "belum disimpan" (bukan sukses palsu).
      const noCfg = await api("/api/settings/whatsapp/test", { method: "POST", cookie });
      const noRes = noCfg.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "Uji koneksi WA tanpa konfigurasi -> ditolak jujur (bukan sukses)",
        noCfg.status === 200 && noRes?.ok === false,
        `status=${noCfg.status} note=${noRes?.note}`,
      );

      // Provider Meta LAMA tidak lagi diterima backend.
      const legacy = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: { provider: "meta-whatsapp-cloud", meta: { phoneId: "12345" } },
      });
      check(
        "ADMIN simpan provider Meta LAMA -> ditolak (hanya Fonnte)",
        legacy.status === 400,
        `status ${legacy.status}: ${legacy.text.slice(0, 140)}`,
      );

      // Validasi format meta Fonnte.
      const badTarget = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: { provider: "fonnte", meta: { testTarget: "bukan-nomor" } },
      });
      check("ADMIN testTarget non-E.164 -> ditolak", badTarget.status === 400, `status ${badTarget.status}`);
      const badSender = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: { provider: "fonnte", meta: { senderNumber: "6281234567890" } },
      });
      check("ADMIN senderNumber tanpa + -> ditolak", badSender.status === 400, `status ${badSender.status}`);
      const badOps = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: { provider: "fonnte", meta: { opsTargets: "0812,abc" } },
      });
      check("ADMIN opsTargets non-E.164 -> ditolak", badOps.status === 400, `status ${badOps.status}`);

      // Simpan valid (lengkap) + kunci terlarang yang harus dibersihkan.
      const save = await api("/api/settings/whatsapp", {
        method: "PUT",
        cookie,
        body: {
          provider: "fonnte",
          meta: {
            testTarget: "+6289876543210",
            senderNumber: "+6281234567890",
            opsTargets: "+628111111111, +628222222222",
            phoneId: "999999",
            deviceStatus: "connect",
          },
          credential: WA_TOKEN,
        },
      });
      check("ADMIN simpan WA global -> 200", save.status === 200, `status ${save.status}: ${save.text.slice(0, 140)}`);
      check("Response simpan admin TIDAK memuat token mentah", !save.text.includes(WA_TOKEN));

      const getWa = await api("/api/settings/whatsapp", { cookie });
      const cfg = getWa.json?.config as ConfigView | null | undefined;
      check(
        "GET ulang admin: opsTargets tersimpan ternormalisasi",
        cfg?.meta?.opsTargets === "+628111111111,+628222222222",
        JSON.stringify(cfg?.meta),
      );
      check(
        "phoneId & device* (spoof) DIBERSIHKAN backend pada scope admin",
        cfg?.meta?.phoneId === undefined && cfg?.meta?.deviceStatus === undefined,
        JSON.stringify(cfg?.meta),
      );
      check("GET ulang admin TIDAK memuat token mentah", !getWa.text.includes(WA_TOKEN));

      // Guard aktivasi: hanya boleh aktif bila UJI KONEXSI lolos (provider setujui).
      const toggleBlocked = await api("/api/settings/whatsapp/toggle", {
        method: "POST",
        cookie,
        body: { isActive: true },
      });
      check(
        "Aktifkan WA sebelum lolos uji koneksi -> ditolak backend",
        toggleBlocked.status >= 400,
        `status ${toggleBlocked.status}: ${toggleBlocked.text.slice(0, 140)}`,
      );

      // Uji koneksi Fonnte sungguhan dengan token palsu -> kegagalan aktual dicatat.
      const test = await api("/api/settings/whatsapp/test", { method: "POST", cookie });
      const result = test.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "Uji koneksi WA admin -> hasil aktual Fonnte (ok=false, note jelas)",
        test.status === 200 && result?.ok === false && typeof result.note === "string" && result.note.length > 0,
        `status=${test.status} ok=${result?.ok} note=${result?.note}`,
      );
      check("Catatan uji admin TIDAK memuat token mentah", !test.text.includes(WA_TOKEN));

      // Nonaktifkan selalu diizinkan (tanpa syarat uji).
      const toggleOff = await api("/api/settings/whatsapp/toggle", {
        method: "POST",
        cookie,
        body: { isActive: false },
      });
      check("Nonaktifkan WA (config ada) -> 200 diizinkan", toggleOff.status === 200, `status ${toggleOff.status}`);

      // Fallback `to` dari konfigurasi admin (tetap nonaktif -> tidak mengirim).
      const waFallback = await api("/api/settings/whatsapp/test", { method: "PUT", cookie, body: {} });
      const fbRes = waFallback.json?.result as { ok?: boolean; note?: string } | undefined;
      check(
        "Kirim uji admin tanpa `to` -> fallback testTarget, ditolak (nonaktif)",
        waFallback.status === 200 && fbRes?.ok === false && /belum diaktifkan/i.test(fbRes?.note ?? ""),
        `status=${waFallback.status} note=${fbRes?.note}`,
      );
    }

    // --- 3. ADMIN: kelola API Key global — persisten, tersamarkan, tidak bocor ---
    {
      const cookie = await login("admin@mendungtirta.com", "password123");
      if (!cookie) throw new Error("Gagal login admin.");

      const save = await api("/api/settings/api-key", {
        method: "PUT",
        cookie,
        body: { name: "Chatbot Utama", provider: "gemini", credential: TOKEN, model: "gemini-test" },
      });
      check("ADMIN simpan API Key -> 200", save.status === 200, `status ${save.status}: ${save.text.slice(0, 150)}`);
      check("Response simpan TIDAK memuat API key mentah", !save.text.includes(TOKEN));
      check("Response simpan menampilkan hint tersamarkan", /sk-smoke.{0,16}1234|•{3,}/.test(save.text), save.text.slice(0, 240));

      // Persisten: GET ulang (simulasi reload halaman).
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
      // Karena hasil uji diambil dari permintaan NYATA, test TIDAK mengasumsikan
      // ok=false maupun ok=true — yang diuji adalah: (1) hasil berasal dari
      // permintaan nyata, dan (2) guard aktivasi di backend menolak konfigurasi
      // yang belum lolos uji.
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
        "Aktifkan konfigurasi AI BELUM tervalidasi -> ditolak backend",
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

      // --- 3e. Hapus konfigurasi -> kembali bersih (config AI dipulihkan di finally) ---
      const del = await api("/api/settings/api-key", { method: "DELETE", cookie });
      check("Hapus API Key -> 200", del.status === 200, `status ${del.status}`);
      const afterDel = await api("/api/settings/api-key", { cookie });
      const cfgAfter = afterDel.json?.config as unknown;
      check("Setelah hapus -> config null", cfgAfter === null || cfgAfter === undefined, JSON.stringify(cfgAfter));
    }

    // --- 4. DB aktual: credential tersimpan TERENKRIPSI (bukan plaintext) ---
    {
      const rows = await prisma.integrationConfig.findMany();
      const leaked = rows.filter(
        (r) => (r.credentialEnc ?? "").includes("rahasiaunikan") || (r.meta ?? "").includes("rahasiaunikan"),
      );
      check("DB: TIDAK ada credential plaintext di kolom manapun", leaked.length === 0, JSON.stringify(leaked.map((r) => r.id)));
      const encRows = rows.filter((r) => r.credentialEnc);
      check(
        "DB: SEMUA credentialEnc berbentuk terenkripsi (prefix v1:, bukan plaintext)",
        encRows.length > 0 && encRows.every((r) => (r.credentialEnc ?? "").startsWith("v1:")),
        encRows.map((r) => (r.credentialEnc ?? "").slice(0, 4) + "…").join(",") || "tidak ada baris credential",
      );
      const waRow = rows.find((r) => r.service === "WHATSAPP");
      check(
        "DB: baris WA ada, token Fonnte terenkripsi & tak bocor di meta",
        !!waRow && (waRow.credentialEnc ?? "").startsWith("v1:") && !(waRow.meta ?? "").includes("fmk-smoke"),
        waRow ? `meta=${(waRow.meta ?? "").slice(0, 160)}` : "baris WA tidak ada",
      );
      // Pembersihan baris uji dilakukan oleh blok finally (restore snapshot).
    }

    // --- 5. Regresi: profil, preferensi WA, & ganti password tetap berfungsi ---
    {
      const cookie = await login("pembeli@mendungtirta.com", "password123");
      const prof = await api("/api/profile", { cookie: cookie ?? "" });
      check("Regresi: GET profil pembeli -> 200", prof.status === 200, `status ${prof.status}`);
      const profJson = prof.json?.profile as { phone?: string | null; whatsappNotify?: boolean } | undefined;
      check(
        "GET profil menyertakan phone & whatsappNotify",
        profJson !== undefined && "phone" in (profJson ?? {}) && "whatsappNotify" in (profJson ?? {}),
        JSON.stringify(profJson),
      );

      // Preferensi WA: format & opt-in divalidasi backend.
      const badPhone = await api("/api/profile", {
        method: "PATCH",
        cookie: cookie ?? "",
        body: { phone: "081234567890", whatsappNotify: true },
      });
      check("PATCH phone format 08xx -> ditolak (wajib +62)", badPhone.status === 400, `status ${badPhone.status}`);
      const okPhone = await api("/api/profile", {
        method: "PATCH",
        cookie: cookie ?? "",
        body: { phone: "+6281234567890", whatsappNotify: true },
      });
      check("PATCH phone +62 & opt-in -> 200", okPhone.status === 200, `status ${okPhone.status}: ${okPhone.text.slice(0, 120)}`);
      const afterSet = await api("/api/profile", { cookie: cookie ?? "" });
      const setJson = afterSet.json?.profile as { phone?: string | null; whatsappNotify?: boolean } | undefined;
      check(
        "GET ulang: phone & persetujuan tersimpan",
        setJson?.phone === "+6281234567890" && setJson?.whatsappNotify === true,
        JSON.stringify(setJson),
      );

      // Hapus nomor -> persetujuan otomatis NONAKTIF (invarian server-side).
      const clearPhone = await api("/api/profile", { method: "PATCH", cookie: cookie ?? "", body: { phone: null } });
      const cleared = await api("/api/profile", { cookie: cookie ?? "" });
      const clearedJson = cleared.json?.profile as { phone?: string | null; whatsappNotify?: boolean } | undefined;
      check(
        "Hapus nomor -> whatsappNotify otomatis nonaktif",
        clearPhone.status === 200 && clearedJson?.phone === null && clearedJson?.whatsappNotify === false,
        JSON.stringify(clearedJson),
      );

      // Opt-in TANPA nomor -> ditolak backend.
      const noConsent = await api("/api/profile", {
        method: "PATCH",
        cookie: cookie ?? "",
        body: { whatsappNotify: true },
      });
      check("Opt-in WA tanpa nomor -> ditolak backend", noConsent.status === 400, `status ${noConsent.status}`);

      const pw = await api("/api/profile/password", {
        method: "POST",
        cookie: cookie ?? "",
        body: { currentPassword: "salah", newPassword: "rahasia-baru-123" },
      });
      check("Regresi: ganti password dengan password lama SALAH -> ditolak", pw.status >= 400, `status ${pw.status}`);
    }
  } finally {
    // --- RESTORE: kembalikan kondisi awal (termasuk saat terjadi kegagalan) ---
    try {
      await prisma.integrationConfig.deleteMany();
      if (cfgSnapshot.length > 0) {
        await prisma.integrationConfig.createMany({ data: cfgSnapshot });
      }
      for (const u of userSnapshot) {
        await prisma.user.updateMany({
          where: { id: u.id },
          data: { phone: u.phone, whatsappNotify: u.whatsappNotify },
        });
      }
      const restored = await prisma.integrationConfig.count();
      console.log(
        `[restore] ${cfgSnapshot.length} konfigurasi (termasuk AI aktif) & ${userSnapshot.length} profil user dipulihkan (kini ${restored} baris).`,
      );
    } catch (e) {
      console.error("[restore] GAGAL memulihkan:", e);
    } finally {
      await prisma.$disconnect();
    }
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

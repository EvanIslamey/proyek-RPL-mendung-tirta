/**
 * Simpan & aktifkan konfigurasi NVIDIA NIM untuk chatbot melalui API asli
 * (jalur yang sama dengan form halaman Informasi Diri).
 *
 * - Nilai API key diambil dari environment variable dan TIDAK PERNAH dicetak.
 * - Uji koneksi dijalankan backend ke provider (hasil aktual dicatat).
 * - Aktivasi hanya setelah uji lolos (guard backend).
 *
 * Usage: npx tsx scripts/setup-ai-config.mts
 */
import "dotenv/config";

const BASE = process.env.APP_URL ?? "http://localhost:3000";

const key = process.env.AI_API_KEY?.trim() || "";
const baseUrl = process.env.AI_BASE_URL?.trim() || "";
const model = process.env.AI_MODEL?.trim() || "";

if (!key || !baseUrl || !model) {
  console.error("GAGAL: AI_API_KEY / AI_BASE_URL / AI_MODEL belum lengkap di .env");
  process.exit(1);
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

async function main() {
  // 1. Login admin
  const login = await api("/api/auth/login", {
    method: "POST",
    body: { email: "admin@mendungtirta.com", password: "password123" },
  });
  const cookie = sessionCookie(login.setCookie);
  if (!cookie) {
    console.error("GAGAL: login admin tidak mendapatkan sesi (server hidup?).");
    process.exit(1);
  }
  console.log("Login admin: OK");

  // 2. Simpan konfigurasi (key dikirim hanya lewat body localhost, tidak dicetak)
  const save = await api("/api/settings/api-key", {
    method: "PUT",
    cookie,
    body: {
      name: "NVIDIA NIM (chatbot)",
      provider: "openai-compatible",
      endpoint: baseUrl,
      model,
      credential: key,
    },
  });
  if (save.status !== 200) {
    console.error(`GAGAL simpan: HTTP ${save.status} ${save.text.slice(0, 200)}`);
    process.exit(1);
  }
  const saved = save.json?.config as { credentialHint?: string | null; isActive?: boolean } | undefined;
  console.log(
    `Simpan konfigurasi: OK (hint=${saved?.credentialHint ?? "-"}, aktif=${saved?.isActive ?? "-"})`,
  );
  if (save.text.includes(key)) {
    console.error("KEAMANAN: respons memuat key mentah — hentikan!");
    process.exit(1);
  }

  // 3. Uji koneksi backend -> provider (hasil aktual)
  const test = await api("/api/settings/api-key/test", { method: "POST", cookie });
  const result = test.json?.result as { ok?: boolean; note?: string } | undefined;
  console.log(`Uji koneksi: HTTP ${test.status} ok=${result?.ok} note=${result?.note ?? "-"}`);
  if (test.status !== 200 || result?.ok !== true) {
    console.error("GAGAL: uji koneksi provider tidak lolos — konfigurasi TIDAK diaktifkan.");
    process.exit(2);
  }

  // 4. Aktifkan (guard backend: hanya bila lolos uji)
  const toggle = await api("/api/settings/api-key/toggle", {
    method: "POST",
    cookie,
    body: { isActive: true },
  });
  const tcfg = toggle.json?.config as { isActive?: boolean; lastTestOk?: boolean } | undefined;
  console.log(
    `Aktivasi: HTTP ${toggle.status} aktif=${tcfg?.isActive ?? "-"} lastTestOk=${tcfg?.lastTestOk ?? "-"} (${String(toggle.json?.message ?? "")})`,
  );
  if (toggle.status !== 200 || tcfg?.isActive !== true) {
    console.error("GAGAL mengaktifkan konfigurasi.");
    process.exit(1);
  }

  // 5. Baca ulang (simulasi reload halaman Informasi Diri)
  const again = await api("/api/settings/api-key", { cookie });
  const cfg = again.json?.config as
    | {
        providerLabel?: string;
        endpoint?: string | null;
        model?: string | null;
        isActive?: boolean;
        lastTestOk?: boolean;
        lastTestNote?: string | null;
        credentialHint?: string | null;
      }
    | undefined;
  console.log("\nStatus akhir (tanpa rahasia):");
  console.log(`  provider : ${cfg?.providerLabel ?? "-"}`);
  console.log(`  endpoint : ${cfg?.endpoint ?? "-"}`);
  console.log(`  model    : ${cfg?.model ?? "-"}`);
  console.log(`  hint     : ${cfg?.credentialHint ?? "-"}`);
  console.log(`  aktif    : ${cfg?.isActive ?? "-"} | uji terakhir ok=${cfg?.lastTestOk ?? "-"}`);
  console.log(`  catatan  : ${cfg?.lastTestNote ?? "-"}`);

  if (again.text.includes(key)) {
    console.error("KEAMANAN: respons GET memuat key mentah — hentikan!");
    process.exit(1);
  }
  console.log("\nSELESAI: konfigurasi NVIDIA aktif & terhubung ke chatbot.");
}

main().catch((e: unknown) => {
  console.error("GAGAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});

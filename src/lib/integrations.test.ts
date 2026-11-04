import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Test logika integrasi (WhatsApp & API Key AI):
 * - Validasi input (URL, nomor WhatsApp, metadata, sanitasi catatan provider).
 * - Otorisasi scope: ADMIN=global, SELLER=milik sendiri, BUYER=ditolak.
 * - resolveAiRuntime: prioritas konfigurasi AKTIF di DB → fallback env,
 *   serta ketahanan terhadap DB error / credential rusak (tidak pernah throw).
 *
 * Prisma & auth di-mock; fetch di-mock untuk uji koneksi provider.
 */

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationConfig: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

vi.mock("./auth", () => ({
  requireUser: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import {
  TELEGRAM_PROVIDERS,
  WHATSAPP_PROVIDERS,
  isValidHttpUrl,
  isValidIndonesiaMobile,
  isValidWhatsAppNumber,
  resolveAiRuntime,
  sanitizeMeta,
  sanitizeProviderNote,
  scopeForUser,
  setIntegrationActive,
  testAiConnection,
  testTelegramConnection,
  testWhatsAppConnection,
  toSafeConfig,
} from "@/lib/integrations";
import { encryptSecret } from "@/lib/secret-store";
import type { SafeUser } from "@/lib/auth";

const cfg = prisma.integrationConfig;
const findUnique = vi.mocked(cfg.findUnique);

/** Row parsial lengkap untuk mock findUnique — resolveAiRuntime hanya butuh field terkait AI. */
function aiConfigRow(p: {
  isActive: boolean;
  credentialEnc?: string | null;
  endpoint?: string | null;
  model?: string | null;
  lastTestOk?: boolean | null;
}) {
  const now = new Date();
  return {
    id: "cfg-1",
    service: "AI_PROVIDER" as const,
    scope: "",
    provider: "openai-compatible",
    credentialHint: null,
    meta: null,
    lastTestAt: null,
    lastTestOk: p.lastTestOk ?? null,
    lastTestNote: null,
    createdAt: now,
    updatedAt: now,
    credentialEnc: p.credentialEnc ?? null,
    endpoint: p.endpoint ?? null,
    model: p.model ?? null,
    isActive: p.isActive,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Validasi input
// ---------------------------------------------------------------------------

describe("isValidHttpUrl", () => {
  it("menerima http/https yang valid", () => {
    expect(isValidHttpUrl("https://api.openai.com/v1")).toBe(true);
    expect(isValidHttpUrl("http://localhost:1234")).toBe(true);
  });

  it("menolak skema berbahaya & nilai kosong", () => {
    expect(isValidHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isValidHttpUrl("ftp://x")).toBe(false);
    expect(isValidHttpUrl("")).toBe(false);
    expect(isValidHttpUrl("bukan url")).toBe(false);
  });
});

describe("isValidWhatsAppNumber", () => {
  it("menerima format E.164 internasional", () => {
    expect(isValidWhatsAppNumber("+6281234567890")).toBe(true);
    expect(isValidWhatsAppNumber("+15551234567")).toBe(true);
  });

  it("menolak format tidak valid", () => {
    expect(isValidWhatsAppNumber("081234567890")).toBe(false); // tanpa kode negara
    expect(isValidWhatsAppNumber("+62812345678901234567")).toBe(false); // terlalu panjang
    expect(isValidWhatsAppNumber("+0812")).toBe(false); // diawali 0
    expect(isValidWhatsAppNumber("")).toBe(false);
  });
});

describe("sanitizeMeta", () => {
  it("membuang nilai kosong/panjang & hanya mempertahankan string", () => {
    expect(sanitizeMeta({ phoneId: "123", empty: "", num: 5 })).toEqual({ phoneId: "123" });
    expect(sanitizeMeta(null)).toBeNull();
    expect(sanitizeMeta([])).toBeNull();
    expect(sanitizeMeta({})).toBeNull();
  });
});

describe("sanitizeProviderNote — tanpa kredensial", () => {
  it("mengganti token panjang dengan [rahasia] & memotong", () => {
    const note = sanitizeProviderNote("gagal dengan token EAAGabc123def456ghi789jkl");
    expect(note).not.toContain("EAAGabc123def456ghi789jkl");
    expect(note).toContain("[rahasia]");

    const long = sanitizeProviderNote("x".repeat(400));
    expect(long.length).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// Otorisasi scope
// ---------------------------------------------------------------------------

function user(role: SafeUser["role"], id = "u1"): SafeUser {
  return {
    id,
    name: "Tes",
    email: "tes@x.com",
    role,
    address: null,
    createdAt: new Date(),
    telegramChatId: null,
    telegramNotify: true,
    telegramLinkedAt: null,
  };
}

describe("scopeForUser — otorisasi role", () => {
  it("ADMIN → scope global untuk kedua layanan", () => {
    expect(scopeForUser(user("ADMIN"), "WHATSAPP")).toBe("");
    expect(scopeForUser(user("ADMIN"), "AI_PROVIDER")).toBe("");
  });

  it("SELLER → scope milik sendiri untuk WhatsApp", () => {
    expect(scopeForUser(user("SELLER", "seller-1"), "WHATSAPP")).toBe("seller-1");
  });

  it("SELLER → DITOLAK untuk API Key AI (global)", () => {
    expect(() => scopeForUser(user("SELLER"), "AI_PROVIDER")).toThrow(/admin/i);
  });

  it("ADMIN → scope global untuk TELEGRAM; SELLER/BUYER DITOLAK (khusus admin)", () => {
    expect(scopeForUser(user("ADMIN"), "TELEGRAM")).toBe("");
    expect(() => scopeForUser(user("SELLER", "seller-1"), "TELEGRAM")).toThrow(/admin/i);
    expect(() => scopeForUser(user("BUYER"), "TELEGRAM")).toThrow(/akses/i);
  });

  it("BUYER → DITOLAK untuk semua layanan integrasi", () => {
    expect(() => scopeForUser(user("BUYER"), "WHATSAPP")).toThrow(/akses/i);
    expect(() => scopeForUser(user("BUYER"), "AI_PROVIDER")).toThrow(/akses/i);
  });
});

// ---------------------------------------------------------------------------
// resolveAiRuntime — prioritas DB aktif → env, dengan fallback tahan-gagal
// ---------------------------------------------------------------------------

describe("resolveAiRuntime", () => {
  const ENV = process.env;

  beforeEach(() => {
    process.env = { ...ENV };
    process.env.AI_API_KEY = "env-key";
    process.env.AI_BASE_URL = "https://env.example/v1";
    process.env.AI_MODEL = "env-model";
  });

  it("tanpa konfigurasi DB → pakai env", async () => {
    findUnique.mockResolvedValueOnce(null);
    const r = await resolveAiRuntime();
    expect(r.source).toBe("env");
    expect(r.apiKey).toBe("env-key");
    expect(r.model).toBe("env-model");
  });

  it("konfigurasi DB AKTIF → diprioritaskan (key dari DB)", async () => {
    findUnique.mockResolvedValueOnce(
      aiConfigRow({
        isActive: true,
        credentialEnc: encryptSecret("db-key"),
        endpoint: "https://db.example/v1/",
        model: "db-model",
      }),
    );
    const r = await resolveAiRuntime();
    expect(r.source).toBe("db");
    expect(r.apiKey).toBe("db-key");
    expect(r.baseUrl).toBe("https://db.example/v1"); // trailing slash dibersihkan
    expect(r.model).toBe("db-model");
  });

  it("konfigurasi DB NONAKTIF → abaikan, pakai env", async () => {
    findUnique.mockResolvedValueOnce(
      aiConfigRow({
        isActive: false,
        credentialEnc: encryptSecret("db-key"),
        endpoint: null,
        model: "db-model",
      }),
    );
    const r = await resolveAiRuntime();
    expect(r.source).toBe("env");
    expect(r.apiKey).toBe("env-key");
  });

  it("DB error → TIDAK throw, fallback env", async () => {
    findUnique.mockRejectedValueOnce(new Error("db down"));
    const r = await resolveAiRuntime();
    expect(r.source).toBe("env");
    expect(r.apiKey).toBe("env-key");
  });

  it("credential rusak / kunci salah → fallback env, tidak throw", async () => {
    findUnique.mockResolvedValueOnce(
      aiConfigRow({
        isActive: true,
        credentialEnc: "v1:xx:yy:zz", // tidak valid
        endpoint: null,
        model: null,
      }),
    );
    const r = await resolveAiRuntime();
    expect(r.source).toBe("env");
    expect(r.apiKey).toBe("env-key");
  });
});

// ---------------------------------------------------------------------------
// Uji koneksi AI (fetch di-mock) — hasil aktual & tanpa bocoran key
// ---------------------------------------------------------------------------

describe("testAiConnection", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  it("HTTP 200 dengan daftar model → sukses", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "model-a" }, { id: "model-b" }] }),
    });
    const r = await testAiConnection({ endpoint: null, credentialEnc: encryptSecret("k") });
    expect(r.ok).toBe(true);
  });

  it("HTTP 200 TANPA daftar model (katalog publik) → TIDAK klaim sukses", async () => {
    // Regresi nyata: endpoint /models NVIDIA mengembalikan 200 + daftar publik
    // bahkan untuk key yang tidak valid. Status 200 saja bukan bukti key diterima.
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [] }) });
    const r = await testAiConnection({ endpoint: null, credentialEnc: encryptSecret("k") });
    expect(r.ok).toBe(false);

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => null });
    const r2 = await testAiConnection({ endpoint: null, credentialEnc: encryptSecret("k") });
    expect(r2.ok).toBe(false);
  });

  it("HTTP 401 → gagal dengan pesan jelas, key tidak bocor", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    const r = await testAiConnection({ endpoint: null, credentialEnc: encryptSecret("rahasia-key") });
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/401|403/i);
    expect(r.note).not.toContain("rahasia-key");
  });

  it("tanpa credential → gagal (jangan klaim terhubung)", async () => {
    const r = await testAiConnection({ endpoint: null, credentialEnc: null });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("jaringan error → gagal, catatan tersanitasi", async () => {
    // Token berisi tanda hubung di tengah (karakteristik token provider) tetap disembunyikan.
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND api-key-xyz123456"));
    const r = await testAiConnection({ endpoint: null, credentialEnc: encryptSecret("k") });
    expect(r.ok).toBe(false);
    expect(r.note).not.toContain("api-key-xyz123456");
    expect(r.note).toContain("[rahasia]");
  });

  it("kata biasa (< 12 alfanumerik) TETAP terbaca di pesan error", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND api.contoh"));
    const r = await testAiConnection({ endpoint: null, credentialEnc: encryptSecret("k") });
    expect(r.note).toContain("api.contoh");
    expect(r.note).not.toContain("[rahasia]");
  });
});

// ---------------------------------------------------------------------------
// Guard aktivasi: jangan aktifkan konfigurasi yang belum tervalidasi
// ---------------------------------------------------------------------------

describe("setIntegrationActive — guard aktivasi", () => {
  it("menolak aktifkan bila uji koneksi terakhir GAGAL", async () => {
    findUnique.mockResolvedValueOnce(aiConfigRow({ isActive: false, lastTestOk: false }));
    const r = await setIntegrationActive("AI_PROVIDER", "", true);
    expect(r.ok).toBe(false);
    expect(cfg.update).not.toHaveBeenCalled(); // tidak pernah menulis status aktif
  });

  it("menolak aktifkan bila BELUM PERNAH diuji (lastTestOk null)", async () => {
    findUnique.mockResolvedValueOnce(aiConfigRow({ isActive: false, lastTestOk: null }));
    const r = await setIntegrationActive("AI_PROVIDER", "", true);
    expect(r.ok).toBe(false);
    expect(cfg.update).not.toHaveBeenCalled();
  });

  it("mengizinkan aktifkan bila uji terakhir BERHASIL", async () => {
    findUnique.mockResolvedValueOnce(aiConfigRow({ isActive: false, lastTestOk: true }));
    vi.mocked(cfg.update).mockResolvedValueOnce(
      aiConfigRow({ isActive: true, lastTestOk: true }) as never,
    );
    const r = await setIntegrationActive("AI_PROVIDER", "", true);
    expect(r.ok).toBe(true);
    expect(cfg.update).toHaveBeenCalled();
  });

  it("nonaktifkan selalu boleh tanpa syarat uji", async () => {
    findUnique.mockResolvedValueOnce(aiConfigRow({ isActive: true, lastTestOk: null }));
    vi.mocked(cfg.update).mockResolvedValueOnce(
      aiConfigRow({ isActive: false, lastTestOk: null }) as never,
    );
    const r = await setIntegrationActive("AI_PROVIDER", "", false);
    expect(r.ok).toBe(true);
  });

  it("konfigurasi belum ada → ditolak jelas", async () => {
    findUnique.mockResolvedValueOnce(null);
    const r = await setIntegrationActive("AI_PROVIDER", "", true);
    expect(r.ok).toBe(false);
    expect(cfg.update).not.toHaveBeenCalled();
  });
});

describe("Provider WhatsApp — migrasi Meta → Fonnte", () => {
  it("hanya Fonnte yang didukung; default endpoint resmi Fonnte", () => {
    expect(Object.keys(WHATSAPP_PROVIDERS)).toEqual(["fonnte"]);
    expect(WHATSAPP_PROVIDERS.fonnte.label).toContain("Fonnte");
    expect(WHATSAPP_PROVIDERS.fonnte.defaultEndpoint).toBe("https://api.fonnte.com");
  });

  it("isValidIndonesiaMobile: +628… diterima, format lain ditolak", () => {
    expect(isValidIndonesiaMobile("+6281234567890")).toBe(true);
    expect(isValidIndonesiaMobile("081234567890")).toBe(false);
    expect(isValidIndonesiaMobile("+627111222333")).toBe(false);
    expect(isValidIndonesiaMobile("")).toBe(false);
  });
});

describe("testWhatsAppConnection — uji koneksi Fonnte (bukan sekadar HTTP 200)", () => {
  const base = { endpoint: null as string | null, provider: "fonnte", meta: null as string | null };
  const enc = encryptSecret("fmk_test_token_secret_value");

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("response sukses → ok + snapshot perangkat + Authorization TANPA Bearer", async () => {
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            device: "6281234567890",
            device_status: "connect",
            name: "Toko Demo",
            quota: "90",
            package: "Reguler",
            expired: "18 November 2029",
            status: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", spy);

    const r = await testWhatsAppConnection({ ...base, credentialEnc: enc });
    expect(r.ok).toBe(true);
    expect(r.device?.number).toBe("6281234567890");
    expect(r.device?.status).toBe("connect");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.fonnte.com/device");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("fmk_test_token_secret_value");
    expect(headers.Authorization).not.toMatch(/^Bearer/i);
  });

  it("HTTP 200 tapi response gagal (status:false) → GAGAL jujur", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: false, reason: "token invalid" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    const r = await testWhatsAppConnection({ ...base, credentialEnc: enc });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("token invalid");
    expect(r.note).not.toContain("fmk_test_token_secret_value");
  });

  it("perangkat terdaftar tapi disconnect → gagal + info perangkat tersedia", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ device: "6281234567890", device_status: "disconnect", status: true }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
    );
    const r = await testWhatsAppConnection({ ...base, credentialEnc: enc });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("disconnect");
    expect(r.device?.number).toBe("6281234567890");
  });

  it("provider LAMA (meta-whatsapp-cloud) → ditolak, TANPA panggilan jaringan", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await testWhatsAppConnection({
      endpoint: null,
      provider: "meta-whatsapp-cloud",
      credentialEnc: enc,
      meta: null,
    });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("tidak dikenali");
    expect(r.note).toContain("Fonnte");
    expect(spy).not.toHaveBeenCalled(); // integrasi lama tidak pernah dihubungi
  });

  it("token belum diisi → jujur, tanpa panggilan jaringan", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await testWhatsAppConnection({ ...base, credentialEnc: null });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("API token");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Telegram — panel Pengaturan Telegram (khusus ADMIN, provider independen)
// ---------------------------------------------------------------------------

describe("Telegram — provider & tampilan konfigurasi aman", () => {
  it("hanya provider telegram-bot yang didukung", () => {
    expect(Object.keys(TELEGRAM_PROVIDERS)).toEqual(["telegram-bot"]);
    expect(TELEGRAM_PROVIDERS["telegram-bot"].label).toBe("Telegram Bot API");
  });

  it("toSafeConfig: label benar, meta non-rahasia tampil, TANPA field token", () => {
    const now = new Date();
    const safe = toSafeConfig({
      id: "cfg-tg",
      service: "TELEGRAM",
      provider: "telegram-bot",
      endpoint: null,
      model: null,
      meta: JSON.stringify({ chatId: "123456789", botUsername: "mendungtirta_bot" }),
      credentialEnc: encryptSecret("123456789:AA-super-secret-token-abcdefgh"),
      credentialHint: "1234…cdefgh",
      isActive: true,
      lastTestAt: now,
      lastTestOk: true,
      lastTestNote: "Terhubung ke bot.",
      createdAt: now,
      updatedAt: now,
    } as Parameters<typeof toSafeConfig>[0]);

    expect(safe.providerLabel).toBe("Telegram Bot API");
    expect(safe.meta?.chatId).toBe("123456789");
    expect(safe.hasCredential).toBe(true);
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("super-secret-token"); // token tak pernah bocor
    expect(serialized).not.toContain("credentialEnc");
  });
});

describe("testTelegramConnection — getMe (verifikasi material, tanpa kebocoran token)", () => {
  const enc = encryptSecret("123456789:AA-test-token-abcdefghijklmnop");

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("getMe ok=true + username → sukses + username bot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              result: { id: 1, is_bot: true, username: "mendungtirta_bot", first_name: "Mendung" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const r = await testTelegramConnection({ credentialEnc: enc });
    expect(r.ok).toBe(true);
    expect(r.username).toBe("mendungtirta_bot");
    expect(r.note).toContain("@mendungtirta_bot");
  });

  it("token salah → gagal jujur (Unauthorized), token TIDAK pernah masuk note", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const r = await testTelegramConnection({ credentialEnc: enc });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("Unauthorized");
    expect(r.note).not.toContain("123456789");
    expect(r.note).not.toContain("AA-test-token");
  });

  it("tanpa token (DB kosong & env kosong) → jujur, tanpa panggilan jaringan", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const r = await testTelegramConnection({ credentialEnc: null });
    expect(r.ok).toBe(false);
    expect(r.note).toContain("Bot Token");
    expect(spy).not.toHaveBeenCalled();
  });
});

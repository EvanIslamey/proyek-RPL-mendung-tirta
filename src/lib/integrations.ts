/**
 * Konfigurasi Integrasi (WhatsApp & API Key AI) untuk halaman Informasi Diri.
 *
 * Peran:
 * - Validasi input konfigurasi (provider, endpoint, credential, model).
 * - CRUD aman: credential disimpan terenkripsi (src/lib/secret-store.ts),
 *   frontend hanya menerima nilai tersamarkan (credentialHint).
 * - Uji koneksi nyata ke provider via backend (bukan dari browser).
 * - resolveAiRuntime(): membaca konfigurasi AI AKTIF dari DB untuk chatbot,
 *   dengan fallback ke environment variable bila tidak ada/konfigurasi rusak.
 *
 * Provider yang didukung saat ini:
 * - WHATSAPP: "meta-whatsapp-cloud" (Meta WhatsApp Cloud API). Endpoint
 *   default https://graph.facebook.com/v21.0 — dikembangkan bila provider lain dibutuhkan.
 * - AI_PROVIDER: OpenAI-compatible / NVIDIA NIM (GET {base}/models untuk uji).
 *
 * Kredensial TIDAK PERNAH dikirim ke frontend, dicatat ke log, atau
 * dimasukkan ke pesan error.
 */

import { prisma } from "./prisma";
import type { IntegrationService } from "../../prisma/generated/client";
import { decryptSecret, encryptSecret, maskSecret } from "./secret-store";
import { requireUser } from "./auth";
import type { SafeUser } from "./auth";

// ---------------------------------------------------------------------------
// Tipe
// ---------------------------------------------------------------------------

export type IntegrationScope = "" | string; // "" = global (ADMIN); lain = userId (SELLER)

export type WhatsAppProviderId = "meta-whatsapp-cloud";
export type AiProviderId = "openai-compatible";

export const WHATSAPP_PROVIDERS: Record<
  WhatsAppProviderId,
  { label: string; defaultEndpoint: string; needsPhoneId: boolean }
> = {
  "meta-whatsapp-cloud": {
    label: "Meta WhatsApp Cloud API",
    defaultEndpoint: "https://graph.facebook.com/v21.0",
    needsPhoneId: true,
  },
};

export const AI_PROVIDERS: Record<AiProviderId, { label: string; defaultBaseUrl: string }> = {
  "openai-compatible": {
    label: "OpenAI-compatible (OpenAI / NVIDIA NIM / ds.)",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
  },
};

/** Bentuk aman (tanpa credential) yang boleh dikirim ke frontend. */
export type SafeIntegrationConfig = {
  id: string;
  service: IntegrationService;
  provider: string;
  providerLabel: string;
  endpoint: string | null;
  model: string | null;
  meta: Record<string, string> | null;
  credentialHint: string | null;
  hasCredential: boolean;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestNote: string | null;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationTestResult = { ok: boolean; note: string };

// ---------------------------------------------------------------------------
// Validasi
// ---------------------------------------------------------------------------

/** URL aman: hanya http/https, maks 500 karakter. */
export function isValidHttpUrl(value: string): boolean {
  if (!value || value.length > 500) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Nomor WhatsApp internasional (E.164): "+" diikuti 8–15 digit. */
export function isValidWhatsAppNumber(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/** Metadata NON-rahasia yang disimpan sebagai JSON string. */
export function sanitizeMeta(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim() && v.length <= 300) out[k] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// Sanitasi pesan kesalahan (tanpa kredensial)
// ---------------------------------------------------------------------------

/**
 * Potong & bersihkan pesan kesalahan provider agar aman ditampilkan/dicatat.
 *
 * Token provider (sk-…, nvapi-…, AIza…) sering memakai tanda hubung di tengah,
 * jadi mencocokkan karakter alfanumerik berurutan tidak cukup. Kita samarkan
 * token apa pun yang mengandung ≥12 karakter alfanumerik (kata biasa < 12 char
 * tetap utuh). Contoh: "api-key-xyz123456" → "[rahasia]".
 */
export function sanitizeProviderNote(input: string): string {
  const cleaned = input
    .replace(/[A-Za-z0-9_.-]+/g, (run) => {
      // Hitung jumlah karakter alfanumerik di dalam run — syarat "panjang".
      const alnum = run.replace(/[^A-Za-z0-9]/g, "").length;
      return alnum >= 12 ? "[rahasia]" : run;
    })
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}…` : cleaned;
}

// ---------------------------------------------------------------------------
// Pemetaan model DB → bentuk aman frontend
// ---------------------------------------------------------------------------

type ConfigRow = {
  id: string;
  service: IntegrationService;
  provider: string;
  endpoint: string | null;
  credentialHint: string | null;
  model: string | null;
  meta: string | null;
  isActive: boolean;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestNote: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export function toSafeConfig(row: ConfigRow): SafeIntegrationConfig {
  let providerLabel = row.provider;
  if (row.service === "WHATSAPP") {
    providerLabel = WHATSAPP_PROVIDERS[row.provider as WhatsAppProviderId]?.label ?? row.provider;
  } else {
    providerLabel = AI_PROVIDERS[row.provider as AiProviderId]?.label ?? row.provider;
  }

  let meta: Record<string, string> | null = null;
  if (row.meta) {
    try {
      meta = sanitizeMeta(JSON.parse(row.meta));
    } catch {
      meta = null;
    }
  }

  return {
    id: row.id,
    service: row.service,
    provider: row.provider,
    providerLabel,
    endpoint: row.endpoint,
    model: row.model,
    meta,
    credentialHint: row.credentialHint,
    hasCredential: Boolean(row.credentialHint),
    isActive: row.isActive,
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestOk: row.lastTestOk,
    lastTestNote: row.lastTestNote,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Penyimpanan (upsert) — credential terenkripsi
// ---------------------------------------------------------------------------

export type SaveConfigInput = {
  service: IntegrationService;
  scope: IntegrationScope;
  provider: string;
  endpoint?: string | null;
  /** Credential baru (plaintext). Bila null/kosong, credential lama DIPERTAHANKAN. */
  credential?: string | null;
  model?: string | null;
  meta?: Record<string, string> | null;
  isActive?: boolean;
};

export async function saveIntegrationConfig(input: SaveConfigInput): Promise<ConfigRow> {
  const metaStr = input.meta ? JSON.stringify(input.meta) : null;
  const endpoint = input.endpoint?.trim() || null;

  const existing = await prisma.integrationConfig.findUnique({
    where: { service_scope: { service: input.service, scope: input.scope } },
  });

  // Enkripsi credential BARU hanya bila diisi; kalau kosong, pertahankan lama.
  let credentialEnc: string | undefined;
  let credentialHint: string | undefined;
  const newCredential = input.credential?.trim() || null;
  if (newCredential) {
    credentialEnc = encryptSecret(newCredential);
    credentialHint = maskSecret(newCredential) ?? undefined;
  }

  const newModel = input.model?.trim() || null;

  // Deteksi perubahan bagian yang mempengaruhi validasi:
  // credential baru, endpoint berubah, atau model berubah.
  const secretChanged =
    (newCredential !== null && newCredential !== undefined) ||
    endpoint !== (existing?.endpoint ?? null) ||
    newModel !== (existing?.model ?? null);

  const data: Record<string, unknown> = {
    provider: input.provider,
    endpoint,
    meta: metaStr,
  };
  if (credentialEnc !== undefined) data.credentialEnc = credentialEnc;
  if (credentialHint !== undefined) data.credentialHint = credentialHint;
  data.model = newModel;

  // Bila bagian rahasia/endpoint/model berubah, reset status uji & JANGAN
  // langsung aktifkan — konfigurasi baru harus tervalidasi dulu (uji koneksi).
  if (secretChanged) {
    data.lastTestOk = null;
    data.lastTestNote = null;
    data.isActive = false;
  } else if (input.isActive !== undefined) {
    data.isActive = input.isActive;
  }

  return prisma.integrationConfig.upsert({
    where: {
      service_scope: { service: input.service, scope: input.scope },
    },
    create: {
      service: input.service,
      scope: input.scope,
      provider: input.provider,
      endpoint,
      credentialEnc: credentialEnc ?? null,
      credentialHint: credentialHint ?? null,
      model: newModel,
      meta: metaStr,
      // Konfigurasi baru SELALU disimpan nonaktif; aktifkan setelah uji koneksi.
      isActive: false,
    },
    update: data,
  });
}

export async function getIntegrationConfig(
  service: IntegrationService,
  scope: IntegrationScope,
): Promise<SafeIntegrationConfig | null> {
  const row = await prisma.integrationConfig.findUnique({
    where: { service_scope: { service, scope } },
  });
  return row ? toSafeConfig(row) : null;
}

/**
 * Aktifkan/nonaktifkan konfigurasi TANPA menyentuh credential (tidak reset uji).
 * Mengaktifkan hanya boleh bila uji koneksi terakhir berhasil (lastTestOk=true),
 * agar API Key/provider yang belum tervalidasi tidak pernah dipakai chatbot.
 */
export async function setIntegrationActive(
  service: IntegrationService,
  scope: IntegrationScope,
  isActive: boolean,
): Promise<{ ok: boolean; message: string; config?: SafeIntegrationConfig }> {
  const row = await prisma.integrationConfig.findUnique({
    where: { service_scope: { service, scope } },
  });
  if (!row) return { ok: false, message: "Konfigurasi belum disimpan." };

  if (isActive && row.lastTestOk !== true) {
    return {
      ok: false,
      message: "Konfigurasi belum tervalidasi. Jalankan uji koneksi terlebih dahulu.",
    };
  }

  const updated = await prisma.integrationConfig.update({
    where: { service_scope: { service, scope } },
    data: { isActive },
  });
  return {
    ok: true,
    message: isActive ? "Konfigurasi diaktifkan." : "Konfigurasi dinonaktifkan.",
    config: toSafeConfig(updated),
  };
}

/** Hapus konfigurasi (mis. untuk kembali memakai environment variable). */
export async function deleteIntegrationConfig(
  service: IntegrationService,
  scope: IntegrationScope,
): Promise<boolean> {
  const res = await prisma.integrationConfig.deleteMany({ where: { service, scope } });
  return res.count > 0;
}

// ---------------------------------------------------------------------------
// Uji koneksi provider
// ---------------------------------------------------------------------------

const TEST_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Uji koneksi WhatsApp Cloud API: GET {endpoint}/{phoneId} dengan Bearer token. */
export async function testWhatsAppConnection(config: {
  endpoint: string | null;
  provider: string;
  credentialEnc: string | null;
  meta: string | null;
}): Promise<IntegrationTestResult> {
  const def = WHATSAPP_PROVIDERS[config.provider as WhatsAppProviderId];
  if (!def) return { ok: false, note: `Provider "${config.provider}" tidak dikenali.` };
  if (!config.credentialEnc) return { ok: false, note: "Access token belum diisi." };

  let token: string;
  try {
    token = decryptSecret(config.credentialEnc);
  } catch {
    return { ok: false, note: "Credential tersimpan tidak dapat dibaca (kunci enkripsi salah)." };
  }

  let meta: Record<string, string> | null = null;
  try {
    meta = config.meta ? (JSON.parse(config.meta) as Record<string, string>) : null;
  } catch {
    meta = null;
  }
  const phoneId = meta?.phoneId?.trim();
  if (def.needsPhoneId && !phoneId) {
    return { ok: false, note: "Phone Number ID belum diisi." };
  }

  const base = (config.endpoint?.trim() || def.defaultEndpoint).replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(phoneId ?? "me")}`;

  try {
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return { ok: true, note: "Koneksi ke provider berhasil." };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, note: "Token ditolak provider (401/403). Periksa access token." };
    }
    return { ok: false, note: `Provider menolak permintaan (HTTP ${res.status}).` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, note: `Gagal menghubungi provider: ${sanitizeProviderNote(msg)}` };
  }
}

/** Uji koneksi AI: GET {baseUrl}/models dengan Bearer key. */
export async function testAiConnection(config: {
  endpoint: string | null;
  credentialEnc: string | null;
}): Promise<IntegrationTestResult> {
  if (!config.credentialEnc) return { ok: false, note: "API key belum diisi." };

  let key: string;
  try {
    key = decryptSecret(config.credentialEnc);
  } catch {
    return { ok: false, note: "Credential tersimpan tidak dapat dibaca (kunci enkripsi salah)." };
  }

  const base = (config.endpoint?.trim() || AI_PROVIDERS["openai-compatible"].defaultBaseUrl).replace(
    /\/+$/,
    "",
  );
  const url = `${base}/models`;

  try {
    const res = await fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, note: "API key ditolak provider (401/403). Periksa API key." };
      }
      return { ok: false, note: `Provider menolak permintaan (HTTP ${res.status}).` };
    }

    // Verifikasi MATERIAL respons, bukan hanya status 200. Sebagian provider
    // (mis. endpoint /models NVIDIA) mengembalikan katalog publik 200 OK bahkan
    // untuk key yang tidak valid — status 200 saja BUKAN bukti key diterima.
    const payload = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const models = Array.isArray(payload?.data) ? payload.data : null;
    if (!models || models.length === 0) {
      return {
        ok: false,
        note: "Provider tidak mengembalikan daftar model — API key kemungkinan tidak valid.",
      };
    }
    return { ok: true, note: `Koneksi ke provider AI berhasil (${models.length} model terdaftar).` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, note: `Gagal menghubungi provider AI: ${sanitizeProviderNote(msg)}` };
  }
}

/** Simpan hasil uji ke baris config (lastTest*). */
export async function recordTestResult(
  service: IntegrationService,
  scope: IntegrationScope,
  result: IntegrationTestResult,
): Promise<void> {
  await prisma.integrationConfig.updateMany({
    where: { service, scope },
    data: {
      lastTestAt: new Date(),
      lastTestOk: result.ok,
      lastTestNote: result.note,
    },
  });
}

/**
 * Ambil baris mentah (berisi credentialEnc terenkripsi) untuk uji koneksi.
 * TIDAK dikirim ke frontend — hanya dipakai backend saat menguji.
 */
async function getRawConfig(service: IntegrationService, scope: IntegrationScope) {
  return prisma.integrationConfig.findUnique({
    where: { service_scope: { service, scope } },
  });
}

/** Muat config + jalankan uji koneksi WhatsApp + catat hasilnya. */
export async function runWhatsAppTest(scope: IntegrationScope): Promise<IntegrationTestResult> {
  const row = await getRawConfig("WHATSAPP", scope);
  if (!row) return { ok: false, note: "Konfigurasi belum disimpan." };
  const result = await testWhatsAppConnection(row);
  await recordTestResult("WHATSAPP", scope, result);
  return result;
}

/** Muat config + jalankan uji koneksi AI + catat hasilnya. */
export async function runAiTest(scope: IntegrationScope): Promise<IntegrationTestResult> {
  const row = await getRawConfig("AI_PROVIDER", scope);
  if (!row) return { ok: false, note: "Konfigurasi belum disimpan." };
  const result = await testAiConnection(row);
  await recordTestResult("AI_PROVIDER", scope, result);
  return result;
}

// ---------------------------------------------------------------------------
// Kirim pesan uji WhatsApp (hanya saat pengguna menekan tombol eksplisit)
// ---------------------------------------------------------------------------

/**
 * Kirim SATU pesan teks uji via WhatsApp Cloud API ke nomor tujuan.
 * Nomor tujuan divalidasi E.164. Pesan hanya dikirim atas aksi eksplisit
 * pengguna (tombol "Kirim Pesan Uji").
 */
export async function sendWhatsAppTestMessage(
  scope: IntegrationScope,
  to: string,
  text: string,
): Promise<IntegrationTestResult> {
  const row = await getRawConfig("WHATSAPP", scope);
  if (!row) return { ok: false, note: "Konfigurasi belum disimpan." };
  if (!row.isActive) {
    return { ok: false, note: "Konfigurasi belum diaktifkan. Aktifkan dulu sebelum mengirim." };
  }
  if (!isValidWhatsAppNumber(to)) {
    return { ok: false, note: "Nomor tujuan tidak valid (format internasional, mis. +62812…)." };
  }
  if (!row.credentialEnc) return { ok: false, note: "Access token belum diisi." };

  let token: string;
  try {
    token = decryptSecret(row.credentialEnc);
  } catch {
    return { ok: false, note: "Credential tersimpan tidak dapat dibaca (kunci enkripsi salah)." };
  }

  const def = WHATSAPP_PROVIDERS[row.provider as WhatsAppProviderId];
  let meta: Record<string, string> | null = null;
  try {
    meta = row.meta ? (JSON.parse(row.meta) as Record<string, string>) : null;
  } catch {
    meta = null;
  }
  const phoneId = meta?.phoneId?.trim();
  const base = (row.endpoint?.trim() || def?.defaultEndpoint || "").replace(/\/+$/, "");
  if (!base || !phoneId) {
    return { ok: false, note: "Endpoint atau Phone Number ID belum diisi." };
  }

  const url = `${base}/${encodeURIComponent(phoneId)}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: text },
  };

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      await recordTestResult("WHATSAPP", scope, { ok: true, note: "Pesan uji terkirim." });
      return { ok: true, note: "Pesan uji terkirim." };
    }
    const note =
      res.status === 401 || res.status === 403
        ? "Token ditolak provider (401/403). Periksa access token."
        : `Provider menolak pengiriman (HTTP ${res.status}).`;
    await recordTestResult("WHATSAPP", scope, { ok: false, note });
    return { ok: false, note };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const note = `Gagal mengirim pesan: ${sanitizeProviderNote(msg)}`;
    await recordTestResult("WHATSAPP", scope, { ok: false, note });
    return { ok: false, note };
  }
}

// ---------------------------------------------------------------------------
// Resolusi scope & otorisasi (dipakai route)
// ---------------------------------------------------------------------------

/**
 * Hitung scope config untuk user: ADMIN → "" (global), SELLER → userId sendiri.
 * BUYER tidak berwenang → melempar Error bertanda `code: "FORBIDDEN"`.
 */
export function scopeForUser(user: SafeUser, service: IntegrationService): IntegrationScope {
  if (user.role === "ADMIN") return "";
  if (user.role === "SELLER") {
    // SELLER hanya boleh mengelola WhatsApp miliknya sendiri, bukan AI global.
    if (service === "AI_PROVIDER") {
      throw Object.assign(new Error("Hanya admin yang dapat mengelola API Key AI."), {
        code: "FORBIDDEN",
      });
    }
    return user.id;
  }
  throw Object.assign(new Error("Anda tidak memiliki akses ke pengaturan integrasi."), {
    code: "FORBIDDEN",
  });
}

export type AuthedIntegrationUser = SafeUser;

/** Guard umum route: wajib login + scope terautorasi. */
export async function requireIntegrationUser(
  service: IntegrationService,
): Promise<{ user: SafeUser; scope: IntegrationScope }> {
  const user = await requireUser();
  const scope = scopeForUser(user, service);
  return { user, scope };
}

// ---------------------------------------------------------------------------
// Resolver runtime AI untuk chatbot
// ---------------------------------------------------------------------------

export type AiRuntime = {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Asal konfigurasi — untuk penandaan status (bukan rahasia). */
  source: "env" | "db";
};

/**
 * Baca konfigurasi AI untuk chatbot.
 * Prioritas: konfigurasi AI AKTIF di DB (milik admin) → environment variable.
 * Segala kesalahan (DB down, credential rusak, env hilang) DITEKAN menjadi
 * fallback env agar chatbot tidak pernah crash — sumber fallback ditandai.
 */
export async function resolveAiRuntime(): Promise<AiRuntime> {
  const envKey = process.env.AI_API_KEY?.trim() || null;
  const envBase = (process.env.AI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const envModel = process.env.AI_MODEL?.trim() || "gpt-4o-mini";
  const envTimeout = (() => {
    const n = Number(process.env.AI_TIMEOUT_MS);
    return Number.isFinite(n) && n >= 1_000 && n <= 120_000 ? n : 30_000;
  })();
  const envRuntime: AiRuntime = {
    apiKey: envKey,
    baseUrl: envBase,
    model: envModel,
    timeoutMs: envTimeout,
    source: "env",
  };

  try {
    const row = await prisma.integrationConfig.findUnique({
      where: { service_scope: { service: "AI_PROVIDER", scope: "" } },
    });
    if (!row || !row.isActive || !row.credentialEnc) return envRuntime;

    const apiKey = decryptSecret(row.credentialEnc);
    if (!apiKey) return envRuntime;

    return {
      apiKey,
      baseUrl: (row.endpoint?.trim() || envBase).replace(/\/+$/, ""),
      model: row.model?.trim() || envModel,
      timeoutMs: envRuntime.timeoutMs,
      source: "db",
    };
  } catch {
    // DB error / credential rusak → pakai env (jangan pernah membocorkan detail).
    return envRuntime;
  }
}

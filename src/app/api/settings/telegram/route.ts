import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";
import {
  ensureTelegramConfig,
  requireIntegrationUser,
  sanitizeMeta,
  saveIntegrationConfig,
  toSafeConfig,
  TELEGRAM_PROVIDERS,
} from "@/lib/integrations";
import { isValidChatId } from "@/lib/telegram";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/settings/telegram — baca konfigurasi Telegram (khusus ADMIN).
 * Baris config dibuat saat pertama dibuka (migrasi data lama: token env
 * TELEGRAM_BOT_TOKEN + Chat ID profil admin yang sudah menautkan Telegram).
 * Murni baca/simpan — TIDAK PERNAH mengirim pesan. Credential tidak pernah
 * dikirim ke frontend — hanya hint tersamarkan + status uji.
 */
export async function GET() {
  try {
    await requireIntegrationUser("TELEGRAM");
    const row = await ensureTelegramConfig();
    return Response.json({ config: toSafeConfig(row) });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/telegram GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PUT /api/settings/telegram — simpan Bot Token & Chat ID (khusus ADMIN).
 * Bot Token disimpan terenkripsi; nilai lama dipertahankan bila field kosong.
 * Kunci meta server-side (botUsername, lastSentAt) dilindungi dari input client.
 * Menyimpan konfigurasi TIDAK PERNAH mengirim pesan otomatis.
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, scope } = await requireIntegrationUser("TELEGRAM");
    const body = await parseJsonBody(request);

    const provider = asTrimmedString(body.provider) || "telegram-bot";
    if (!(provider in TELEGRAM_PROVIDERS)) {
      throw new ApiError(400, "Data tidak valid.", { provider: "Provider tidak dikenali." });
    }

    const errors: Record<string, string> = {};

    // Bot Token: hanya diproses bila diisi (kosong = token lama dipertahankan).
    const credentialRaw = body.credential === undefined ? "" : asTrimmedString(body.credential);
    let credential: string | null = null;
    if (credentialRaw) {
      if (credentialRaw.length < 8 || credentialRaw.length > 1000 || /\s/.test(credentialRaw)) {
        errors.credential = "Bot Token tidak valid (8–1000 karakter, tanpa spasi).";
      } else {
        credential = credentialRaw;
      }
    }

    const metaInput =
      body.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
        ? (body.meta as Record<string, unknown>)
        : null;

    // Kunci yang TIDAK boleh ditentukan client (hanya dari hasil uji server).
    const clientMeta: Record<string, string> = {};
    if (metaInput) {
      const sanitized = sanitizeMeta(metaInput) ?? {};
      for (const [k, v] of Object.entries(sanitized)) {
        if (k === "botUsername" || k === "lastSentAt") continue;
        clientMeta[k] = v;
      }
    }

    // Chat ID tujuan: hadir & kosong = bersihkan; diisi = wajib format angka.
    const chatIdProvided = metaInput !== null && "chatId" in metaInput;
    const chatIdValue = chatIdProvided ? asTrimmedString(metaInput.chatId) : "";
    if (chatIdProvided && chatIdValue && !isValidChatId(chatIdValue)) {
      errors.chatId = "Chat ID tidak valid (hanya angka; negatif untuk grup/channel, mis. -1001234567890).";
    }

    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }

    // Gabungkan dengan meta lama agar status uji server (botUsername/lastSentAt)
    // tidak hilang saat menyimpan.
    let existingMeta: Record<string, string> = {};
    const existing = await prisma.integrationConfig.findUnique({
      where: { service_scope: { service: "TELEGRAM", scope } },
      select: { meta: true },
    });
    if (existing?.meta) {
      try {
        const parsed: unknown = JSON.parse(existing.meta);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existingMeta = sanitizeMeta(parsed) ?? {};
        }
      } catch {
        // meta rusak → mulai bersih
      }
    }
    const meta: Record<string, string> = { ...existingMeta, ...clientMeta };
    if (chatIdProvided) {
      if (chatIdValue) meta.chatId = chatIdValue;
      else delete meta.chatId;
    }

    const row = await saveIntegrationConfig({
      service: "TELEGRAM",
      scope,
      provider,
      endpoint: null,
      credential,
      meta: Object.keys(meta).length > 0 ? meta : null,
    });

    console.info(
      `[audit] user=${user.id} role=${user.role} simpan konfigurasi Telegram (scope=${scope || "global"}, credential=${credential ? "baru" : "dipertahankan"})`,
    );

    return Response.json({ message: "Konfigurasi Telegram tersimpan.", config: toSafeConfig(row) });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/telegram PUT]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

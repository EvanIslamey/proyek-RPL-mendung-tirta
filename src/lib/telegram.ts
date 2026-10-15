/**
 * Telegram Bot API Integration for Mendung Tirta.
 *
 * Fitur:
 * - Kirim notifikasi ke admin & pengguna via Telegram
 * - Proses linking akun Telegram (token sekali pakai, masa berlaku pendek)
 * - Webhook handler untuk menerima update dari Telegram
 * - Rate limiting & error handling
 * - Token & chat ID HANYA di backend, tidak pernah ke frontend
 */

import { prisma } from "./prisma";
import { sanitizeEmailError } from "./notify";

const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

/** Konfigurasi bot dari environment variable. */
function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN belum dikonfigurasi.");
  return token;
}

/** Dapatkan URL lengkap endpoint Telegram API. */
function telegramApi(method: string): string {
  return `${TELEGRAM_API_BASE}${getBotToken()}/${method}`;
}

/** Validasi format chat ID (angka negatif untuk group/channel, positif untuk user). */
export function isValidChatId(chatId: string): boolean {
  return /^-?\d+$/.test(chatId.trim());
}

/** Generate token linking acak (URL-safe, 32 bytes). */
export function generateLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hash token linking untuk disimpan di DB (SHA-256). */
export async function hashLinkToken(token: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Kirim pesan Telegram via Bot API (sendMessage). */
export async function sendTelegramMessage(chatId: string, text: string, options?: {
  parseMode?: "HTML" | "MarkdownV2";
  disableWebPagePreview?: boolean;
}): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      disable_web_page_preview: options?.disableWebPagePreview ?? true,
    };
    if (options?.parseMode) body.parse_mode = options.parseMode;

    const res = await fetch(telegramApi("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      const desc = data.description || `HTTP ${res.status}`;
      return { ok: false, error: `Telegram API: ${desc}` };
    }
    return { ok: true, messageId: data.result?.message_id };
  } catch (e) {
    return { ok: false, error: sanitizeEmailError(e) };
  }
}

/** Set webhook Telegram. */
export async function setTelegramWebhook(url: string, secretToken?: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = { url, drop_pending_updates: true };
    if (secretToken) body.secret_token = secretToken;

    const res = await fetch(telegramApi("setWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: sanitizeEmailError(e) };
  }
}

/** Hapus webhook Telegram. */
export async function deleteTelegramWebhook(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(telegramApi("deleteWebhook"), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: sanitizeEmailError(e) };
  }
}

/** Verifikasi secret token webhook (header X-Telegram-Bot-Api-Secret-Token). */
export function verifyWebhookSecret(request: Request, expectedSecret: string): boolean {
  const header = request.headers.get("x-telegram-bot-api-secret-token");
  return header === expectedSecret;
}

/** Proses update webhook (linking akun via /start <token>). */
export async function processTelegramUpdate(update: {
  message?: {
    chat: { id: number; first_name?: string; last_name?: string; username?: string };
    text?: string;
    from: { id: number; username?: string; first_name?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data: string;
    message?: { chat: { id: number }; message_id: number };
  };
}): Promise<void> {
  // Hanya proses pesan teks untuk linking
  if (!update.message?.text) return;

  const chatId = String(update.message.chat.id);
  const text = update.message.text.trim();
  const _userId = update.message.from.id;

  // Cek command /start dengan token linking
  const match = text.match(/^\/start\s+([a-f0-9]{64})$/i);
  if (!match) return;

  const linkToken = match[1].toLowerCase();
  const tokenHash = await hashLinkToken(linkToken);

  // Cari token linking yang valid & belum kedaluwarsa (15 menit)
  const pending = await prisma.user.findFirst({
    where: {
      telegramLinkTokenHash: tokenHash,
      telegramLinkExpiresAt: { gt: new Date() },
    },
    select: { id: true, name: true, telegramLinkTokenHash: true },
  });

  if (!pending) {
    await sendTelegramMessage(chatId, "Token linking tidak valid atau sudah kadaluwarsa. Silakan minta token baru dari pengaturan notifikasi di website.");
    return;
  }

  // Cek apakah chat ID sudah dipakai user lain
  const existingChat = await prisma.user.findFirst({
    where: { telegramChatId: chatId, id: { not: pending.id } },
    select: { id: true },
  });
  if (existingChat) {
    await sendTelegramMessage(chatId, "Akun Telegram ini sudah terhubung ke akun Mendung Tirta yang lain. Satu akun Telegram hanya bisa terhubung ke satu akun website.");
    return;
  }

  // Linking berhasil - update user
  await prisma.user.update({
    where: { id: pending.id },
    data: {
      telegramChatId: chatId,
      telegramLinkedAt: new Date(),
      telegramLinkTokenHash: null,
      telegramLinkExpiresAt: null,
      telegramNotify: true,
    },
  });

  await sendTelegramMessage(chatId, `Akun Telegram berhasil dihubungkan ke **${pending.name}** (Mendung Tirta).\n\nAnda akan menerima notifikasi aktivitas penting melalui bot ini.`);
}

/** Kirim notifikasi Telegram ke user (jika telegramNotify aktif & chatId ada). */
export async function sendTelegramNotification(userId: string, title: string, body: string, link?: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramChatId: true, telegramNotify: true, name: true },
  });
  if (!user?.telegramChatId || !user.telegramNotify) return;

  const lines = [
    `🔔 <b>${escapeHtml(title)}</b>`,
    "",
    escapeHtml(body),
  ];
  if (link) {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/+$/, "") || "https://mendungtirta.com";
    lines.push("", `<a href="${escapeHtml(baseUrl + link)}">🔗 Buka di Mendung Tirta</a>`);
  }

  await sendTelegramMessage(user.telegramChatId, lines.join("\n"), { parseMode: "HTML" });
}

/** Kirim notifikasi Telegram ke semua admin (untuk alert sistem). */
export async function sendTelegramToAdmins(title: string, body: string): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true, telegramChatId: { not: null }, telegramNotify: true },
    select: { telegramChatId: true },
  });
  for (const admin of admins) {
    if (admin.telegramChatId) {
      await sendTelegramMessage(admin.telegramChatId, `🔔 <b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`, { parseMode: "HTML" });
    }
  }
}

/** Escape HTML untuk keamanan pesan Telegram. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}
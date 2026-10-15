import type { NextRequest } from "next/server";
import { verifyWebhookSecret, processTelegramUpdate } from "@/lib/telegram";

/**
 * POST /api/telegram/webhook — endpoint webhook Telegram.
 * Header wajib: X-Telegram-Bot-Api-Secret-Token (sesuai TELEGRAM_WEBHOOK_SECRET).
 * Body: update object dari Telegram.
 */
export async function POST(request: NextRequest) {
  try {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
    if (!secret) {
      return Response.json({ message: "Webhook secret tidak dikonfigurasi." }, { status: 500 });
    }

    // Verifikasi secret token
    if (!verifyWebhookSecret(request, secret)) {
      return Response.json({ message: "Invalid webhook secret." }, { status: 401 });
    }

    const update = await request.json().catch(() => null);
    if (!update) {
      return Response.json({ message: "Invalid JSON." }, { status: 400 });
    }

    // Proses update (async, tidak block response)
    void processTelegramUpdate(update);

    // Response cepat ke Telegram (OK dalam 1 detik)
    return Response.json({ ok: true });
  } catch (e) {
    console.error("[api/telegram/webhook]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}
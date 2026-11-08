import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { generateLinkToken, hashLinkToken } from "@/lib/telegram";
import { prisma } from "@/lib/prisma";
import { hitRateLimit } from "@/lib/rate-limit";
import { ApiError, assertSameOrigin } from "@/lib/validate";

/**
 * POST /api/telegram/link — buat token linking Telegram untuk user yang login.
 * Token hanya bisa dipakai sekali, berlaku 15 menit.
 * Response: { token, expiresAt, botUsername }
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();

    // Endpoint sensitif (mencetak token linking) → batasi pembuatan per akun.
    const limit = hitRateLimit(`tg-link:${user.id}`, 10, 300_000);
    if (!limit.ok) {
      return Response.json(
        { message: `Terlalu banyak permintaan. Coba lagi dalam ${limit.retryAfterSeconds} detik.` },
        { status: 429 },
      );
    }

    // Cek apakah sudah terhubung
    if (user.telegramChatId) {
      return Response.json({ message: "Akun Telegram sudah terhubung." }, { status: 400 });
    }

    // Generate token linking
    const token = generateLinkToken();
    const tokenHash = await hashLinkToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 menit

    await prisma.user.update({
      where: { id: user.id },
      data: {
        telegramLinkTokenHash: tokenHash,
        telegramLinkExpiresAt: expiresAt,
      },
    });

    // Ambil username bot untuk ditampilkan ke user
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    let botUsername = "MendungTirtaBot";
    if (botToken) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, { signal: AbortSignal.timeout(5000) });
        const data = await res.json().catch(() => ({}));
        if (data.ok && data.result?.username) botUsername = data.result.username;
      } catch {
        // ignore
      }
    }

    return Response.json({
      token,
      expiresAt: expiresAt.toISOString(),
      botUsername,
      instructions: `1. Buka Telegram dan cari @${botUsername}\n2. Kirim perintah: /start ${token}\n3. Token berlaku 15 menit dan hanya bisa dipakai sekali.`,
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/telegram/link]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}
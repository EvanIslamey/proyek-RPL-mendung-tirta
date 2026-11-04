import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";
import {
  ensureTelegramConfig,
  requireIntegrationUser,
  runTelegramTest,
  sendTelegramTestMessage,
} from "@/lib/integrations";
import { hitRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/settings/telegram/test — uji koneksi Telegram (getMe) via backend.
 * Hasil = verifikasi MATERIAL respons Telegram (ok=true + username bot),
 * bukan sekadar status HTTP. Token tidak pernah masuk log/pesan.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, scope } = await requireIntegrationUser("TELEGRAM");

    const rl = hitRateLimit(`tg-test:${user.id}`, 10, 60_000);
    if (!rl.ok) {
      throw new ApiError(429, `Terlalu banyak percobaan. Coba lagi dalam ${rl.retryAfterSeconds} detik.`);
    }

    await ensureTelegramConfig(); // baris pasti ada walau GET belum dipanggil
    const result = await runTelegramTest(scope);
    console.info(
      `[audit] user=${user.id} uji koneksi Telegram (scope=${scope || "global"}, ok=${result.ok})`,
    );
    return Response.json({ result });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error(
      "[api/settings/telegram/test POST]",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PUT /api/settings/telegram/test — kirim SATU pesan uji ke Chat ID tersimpan.
 * Hanya dikirim atas aksi eksplisit pengguna (tombol "Kirim Pesan Uji");
 * konfigurasi wajib sudah aktif (dicek di backend).
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, scope } = await requireIntegrationUser("TELEGRAM");
    const body = await parseJsonBody(request);

    const rl = hitRateLimit(`tg-msg:${user.id}`, 5, 60_000);
    if (!rl.ok) {
      throw new ApiError(429, `Terlalu banyak percobaan. Coba lagi dalam ${rl.retryAfterSeconds} detik.`);
    }

    const text =
      asTrimmedString(body.text) ||
      "Pesan uji dari Mendung Tirta. Jika Anda menerima ini, integrasi Telegram berfungsi.";
    if (text.length > 4000) {
      throw new ApiError(400, "Data tidak valid.", { text: "Pesan uji maksimal 4000 karakter." });
    }

    const result = await sendTelegramTestMessage(scope, text);
    console.info(
      `[audit] user=${user.id} kirim pesan uji Telegram (scope=${scope || "global"}, ok=${result.ok})`,
    );
    return Response.json({ result });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error(
      "[api/settings/telegram/test PUT]",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

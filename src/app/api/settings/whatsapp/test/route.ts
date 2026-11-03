import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";
import {
  getIntegrationConfig,
  isValidWhatsAppNumber,
  requireIntegrationUser,
  runWhatsAppTest,
  sendWhatsAppTestMessage,
} from "@/lib/integrations";
import { hitRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/settings/whatsapp/test — uji koneksi Fonnte (backend).
 * Hasil yang ditampilkan adalah HASIL AKTUAL response Fonnte (/device),
 * termasuk status koneksi perangkat — bukan sekadar status HTTP.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, scope } = await requireIntegrationUser("WHATSAPP");

    const rl = hitRateLimit(`wa-test:${user.id}`, 10, 60_000);
    if (!rl.ok) {
      throw new ApiError(429, `Terlalu banyak percobaan. Coba lagi dalam ${rl.retryAfterSeconds} detik.`);
    }

    const result = await runWhatsAppTest(scope);
    console.info(
      `[audit] user=${user.id} uji koneksi WhatsApp (scope=${scope || "global"}, ok=${result.ok})`,
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
      "[api/settings/whatsapp/test POST]",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * POST /api/settings/whatsapp/test-message — kirim pesan teks uji.
 * Hanya dikirim atas aksi eksplisit pengguna (tombol). Nomor divalidasi E.164.
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, scope } = await requireIntegrationUser("WHATSAPP");
    const body = await parseJsonBody(request);

    const rl = hitRateLimit(`wa-msg:${user.id}`, 5, 60_000);
    if (!rl.ok) {
      throw new ApiError(429, `Terlalu banyak percobaan. Coba lagi dalam ${rl.retryAfterSeconds} detik.`);
    }

    let to = asTrimmedString(body.to);
    if (!to) {
      // Nomor tidak dikirim → pakai nomor tujuan pengujian tersimpan di konfigurasi.
      const cfg = await getIntegrationConfig("WHATSAPP", scope);
      to = cfg?.meta?.testTarget?.trim() || "";
    }
    if (!isValidWhatsAppNumber(to)) {
      throw new ApiError(400, "Data tidak valid.", {
        to: "Nomor tidak valid. Gunakan format internasional, mis. +6281234567890.",
      });
    }
    const text =
      asTrimmedString(body.text) ||
      "Pesan uji dari Mendung Tirta. Jika Anda menerima ini, integrasi WhatsApp berfungsi.";

    const result = await sendWhatsAppTestMessage(scope, to, text);
    console.info(
      `[audit] user=${user.id} kirim pesan uji WhatsApp (scope=${scope || "global"}, ok=${result.ok})`,
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
      "[api/settings/whatsapp/test-message PUT]",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

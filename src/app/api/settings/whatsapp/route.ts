import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";
import {
  getIntegrationConfig,
  isValidHttpUrl,
  isValidIndonesiaMobile,
  isValidWhatsAppNumber,
  requireIntegrationUser,
  sanitizeMeta,
  saveIntegrationConfig,
  toSafeConfig,
  WHATSAPP_PROVIDERS,
} from "@/lib/integrations";

/**
 * GET /api/settings/whatsapp — baca konfigurasi WhatsApp (wajib login).
 * ADMIN membaca konfigurasi global; SELLER membaca miliknya sendiri.
 * Credential tidak pernah dikirim — hanya hint tersamarkan + status uji.
 */
export async function GET() {
  try {
    const { scope } = await requireIntegrationUser("WHATSAPP");
    const config = await getIntegrationConfig("WHATSAPP", scope);
    return Response.json({ config });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/whatsapp GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PUT /api/settings/whatsapp — simpan konfigurasi WhatsApp (Fonnte).
 * Credential disimpan terenkripsi; nilai lama dipertahankan bila field kosong.
 * Field Meta lama (Phone Number ID) tidak lagi diterima; status perangkat
 * hanya boleh berasal dari uji koneksi (dibersihkan dari input client).
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, scope } = await requireIntegrationUser("WHATSAPP");
    const body = await parseJsonBody(request);

    const provider = asTrimmedString(body.provider) || "fonnte";
    if (!(provider in WHATSAPP_PROVIDERS)) {
      throw new ApiError(400, "Data tidak valid.", { provider: "Provider tidak dikenali." });
    }

    const errors: Record<string, string> = {};

    const endpointRaw = body.endpoint === undefined ? "" : asTrimmedString(body.endpoint);
    let endpoint: string | null = null;
    if (endpointRaw) {
      if (!isValidHttpUrl(endpointRaw)) {
        errors.endpoint = "URL tidak valid (harus http/https).";
      } else {
        endpoint = endpointRaw;
      }
    }

    // Credential (API token Fonnte): hanya diproses bila diisi (kosong = lama).
    const credentialRaw = body.credential === undefined ? "" : asTrimmedString(body.credential);
    let credential: string | null = null;
    if (credentialRaw) {
      if (credentialRaw.length < 5 || credentialRaw.length > 2000) {
        errors.credential = "API token tidak valid (5–2000 karakter).";
      } else {
        credential = credentialRaw;
      }
    }

    // Metadata non-rahasia: nomor tujuan uji, nomor pengirim, penerima notifikasi.
    const meta = sanitizeMeta(body.meta) ?? {};
    // Kunci yang TIDAK boleh ditentukan client:
    // - phoneId: sisa integrasi Meta (sudah tidak digunakan);
    // - device*: status perangkat hanya dari hasil Uji Koneksi provider.
    for (const k of [
      "phoneId",
      "deviceNumber",
      "deviceStatus",
      "deviceName",
      "deviceQuota",
      "devicePackage",
      "deviceExpired",
    ]) {
      delete meta[k];
    }

    // Nomor tujuan pengujian (opsional): wajib E.164 bila diisi.
    if (meta.testTarget && !isValidWhatsAppNumber(meta.testTarget)) {
      errors.testTarget =
        "Nomor tujuan pengujian tidak valid (format internasional, mis. +6281234567890).";
    }

    // Nomor WhatsApp pengirim/perangkat (opsional, informasional): format +62.
    if (meta.senderNumber && !isValidIndonesiaMobile(meta.senderNumber)) {
      errors.senderNumber =
        "Nomor pengirim harus format internasional Indonesia (+62812…), bukan 08xx.";
    }

    // Penerima notifikasi operasional (HANYA konfigurasi global/admin).
    if (meta.opsTargets) {
      if (scope !== "") {
        delete meta.opsTargets; // seller tidak boleh mengatur penerima operasional global
      } else {
        const list = meta.opsTargets
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const invalid = list.filter((s) => !isValidWhatsAppNumber(s));
        if (invalid.length > 0 || list.length === 0) {
          errors.opsTargets =
            "Daftar nomor penerima harus nomor internasional (+628…) dipisah koma.";
        } else {
          meta.opsTargets = list.join(",");
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }

    const row = await saveIntegrationConfig({
      service: "WHATSAPP",
      scope,
      provider,
      endpoint,
      credential,
      meta: Object.keys(meta).length > 0 ? meta : null,
    });

    console.info(
      `[audit] user=${user.id} role=${user.role} simpan konfigurasi WhatsApp (provider=${provider}, scope=${scope || "global"})`,
    );

    return Response.json({ message: "Konfigurasi WhatsApp tersimpan.", config: toSafeConfig(row) });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/whatsapp PUT]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

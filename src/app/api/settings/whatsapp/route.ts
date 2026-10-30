import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";
import {
  getIntegrationConfig,
  isValidHttpUrl,
  requireIntegrationUser,
  sanitizeMeta,
  saveIntegrationConfig,
  toSafeConfig,
  WHATSAPP_PROVIDERS,
  type WhatsAppProviderId,
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
 * PUT /api/settings/whatsapp — simpan konfigurasi WhatsApp.
 * Credential disimpan terenkripsi; nilai lama dipertahankan bila field kosong.
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user, scope } = await requireIntegrationUser("WHATSAPP");
    const body = await parseJsonBody(request);

    const provider = asTrimmedString(body.provider) || "meta-whatsapp-cloud";
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

    // Credential: hanya diproses bila diisi (kosong = pertahankan lama).
    const credentialRaw = body.credential === undefined ? "" : asTrimmedString(body.credential);
    let credential: string | null = null;
    if (credentialRaw) {
      if (credentialRaw.length < 5 || credentialRaw.length > 2000) {
        errors.credential = "Access token tidak valid (5–2000 karakter).";
      } else {
        credential = credentialRaw;
      }
    }

    // Metadata non-rahasia (phoneId, dst.).
    const meta = sanitizeMeta(body.meta);
    const needsPhoneId = WHATSAPP_PROVIDERS[provider as WhatsAppProviderId].needsPhoneId;
    if (needsPhoneId && !meta?.phoneId) {
      errors.phoneId = "Phone Number ID wajib diisi untuk provider ini.";
    } else if (needsPhoneId && meta?.phoneId) {
      // Phone Number ID Meta adalah ANGKA ID dari Developer Dashboard —
      // tolak email / nomor WhatsApp (kesalahan input yang umum).
      if (!/^\d{5,25}$/.test(meta.phoneId)) {
        errors.phoneId =
          "Phone Number ID harus berupa angka ID dari Meta Developer Dashboard (WhatsApp → API Setup), bukan email atau nomor WhatsApp.";
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
      meta,
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

import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";
import {
  AI_PROVIDERS,
  deleteIntegrationConfig,
  getIntegrationConfig,
  isValidHttpUrl,
  requireIntegrationUser,
  saveIntegrationConfig,
  toSafeConfig,
} from "@/lib/integrations";

/**
 * GET /api/settings/api-key — baca konfigurasi API Key AI (hanya ADMIN).
 * Nilai API key asli TIDAK PERNAH dikirim — hanya hint tersamarkan + status uji.
 */
export async function GET() {
  try {
    await requireIntegrationUser("AI_PROVIDER"); // guard: hanya ADMIN lolos
    const config = await getIntegrationConfig("AI_PROVIDER", "");
    return Response.json({ config });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/api-key GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PUT /api/settings/api-key — simpan konfigurasi API Key AI (hanya ADMIN).
 * Credential disimpan terenkripsi; nilai lama dipertahankan bila field kosong.
 * Konfigurasi baru selalu disimpan NONAKTIF sampai lolos uji koneksi.
 */
export async function PUT(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user } = await requireIntegrationUser("AI_PROVIDER");
    const body = await parseJsonBody(request);

    const provider = asTrimmedString(body.provider) || "openai-compatible";
    if (!(provider in AI_PROVIDERS)) {
      throw new ApiError(400, "Data tidak valid.", { provider: "Provider tidak dikenali." });
    }

    const errors: Record<string, string> = {};

    const name = asTrimmedString(body.name); // nama konfigurasi (non-rahasia, disimpan di meta)
    const endpointRaw = body.endpoint === undefined ? "" : asTrimmedString(body.endpoint);
    let endpoint: string | null = null;
    if (endpointRaw) {
      if (!isValidHttpUrl(endpointRaw)) {
        errors.endpoint = "URL tidak valid (harus http/https).";
      } else {
        endpoint = endpointRaw;
      }
    }

    const credentialRaw = body.credential === undefined ? "" : asTrimmedString(body.credential);
    let credential: string | null = null;
    if (credentialRaw) {
      if (credentialRaw.length < 8 || credentialRaw.length > 2000) {
        errors.credential = "API key tidak valid (8–2000 karakter).";
      } else {
        credential = credentialRaw;
      }
    }

    const model = body.model === undefined ? "" : asTrimmedString(body.model);

    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }

    const meta = name ? { name } : null;
    const row = await saveIntegrationConfig({
      service: "AI_PROVIDER",
      scope: "",
      provider,
      endpoint,
      credential,
      model: model || null,
      meta,
    });

    console.info(
      `[audit] user=${user.id} role=${user.role} simpan konfigurasi API Key AI (provider=${provider})`,
    );

    return Response.json({ message: "Konfigurasi API Key tersimpan.", config: toSafeConfig(row) });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/api-key PUT]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * DELETE /api/settings/api-key — hapus konfigurasi API Key (hanya ADMIN).
 * Setelah dihapus, chatbot kembali memakai environment variable.
 */
export async function DELETE(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user } = await requireIntegrationUser("AI_PROVIDER");
    const removed = await deleteIntegrationConfig("AI_PROVIDER", "");
    if (!removed) {
      return Response.json({ message: "Tidak ada konfigurasi untuk dihapus." }, { status: 404 });
    }
    console.info(`[audit] user=${user.id} role=${user.role} hapus konfigurasi API Key AI`);
    return Response.json({ message: "Konfigurasi dihapus. Chatbot memakai environment variable." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/api-key DELETE]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

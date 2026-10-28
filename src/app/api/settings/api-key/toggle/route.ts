import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";
import { requireIntegrationUser, setIntegrationActive, toSafeConfig } from "@/lib/integrations";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/settings/api-key/toggle — aktifkan/nonaktifkan API Key AI (hanya ADMIN).
 * Mengaktifkan hanya boleh bila uji koneksi terakhir berhasil (validasi backend).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user } = await requireIntegrationUser("AI_PROVIDER");
    const body = await parseJsonBody(request);

    if (typeof body.isActive !== "boolean") {
      throw new ApiError(400, "Data tidak valid.", { isActive: "Nilai harus boolean." });
    }

    const outcome = await setIntegrationActive("AI_PROVIDER", "", body.isActive);
    if (!outcome.ok) {
      return Response.json({ message: outcome.message }, { status: 400 });
    }

    console.info(
      `[audit] user=${user.id} role=${user.role} ${body.isActive ? "aktifkan" : "nonaktifkan"} API Key AI`,
    );

    // Ambil config terbaru untuk dikirim (aman, tanpa credential).
    const row = await prisma.integrationConfig.findUnique({
      where: { service_scope: { service: "AI_PROVIDER", scope: "" } },
    });
    return Response.json({
      message: outcome.message,
      config: row ? toSafeConfig(row) : null,
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error(
      "[api/settings/api-key/toggle POST]",
      e instanceof Error ? `${e.name}: ${e.message}` : e,
    );
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

import type { NextRequest } from "next/server";
import { ApiError, assertSameOrigin } from "@/lib/validate";
import { requireIntegrationUser, runAiTest } from "@/lib/integrations";
import { hitRateLimit } from "@/lib/rate-limit";

/**
 * POST /api/settings/api-key/test — uji koneksi provider AI (hanya ADMIN).
 * Hasil yang ditampilkan adalah HASIL AKTUAL permintaan GET {base}/models.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const { user } = await requireIntegrationUser("AI_PROVIDER");

    const rl = hitRateLimit(`ai-test:${user.id}`, 10, 60_000);
    if (!rl.ok) {
      throw new ApiError(429, `Terlalu banyak percobaan. Coba lagi dalam ${rl.retryAfterSeconds} detik.`);
    }

    const result = await runAiTest("");
    console.info(`[audit] user=${user.id} uji koneksi API Key AI (ok=${result.ok})`);
    return Response.json({ result });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    if (e instanceof Error && (e as { code?: string }).code === "FORBIDDEN") {
      return Response.json({ message: e.message }, { status: 403 });
    }
    console.error("[api/settings/api-key/test POST]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

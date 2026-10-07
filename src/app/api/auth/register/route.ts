import type { NextRequest } from "next/server";
import { registerUser, startSession } from "@/lib/auth";
import { clientIp, hitRateLimit } from "@/lib/rate-limit";
import { ApiError, assertSameOrigin, parseJsonBody, validateRegister } from "@/lib/validate";

/**
 * POST /api/auth/register — registrasi baru (pembeli ATAU penjual).
 * Role ADMIN ditolak oleh validasi (jatuh ke BUYER) sehingga admin hanya
 * bisa dibuat lewat seed/database.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);

    const ip = clientIp(request);
    const limit = hitRateLimit(`register:${ip}`, 10, 5 * 60_000);
    if (!limit.ok) {
      return Response.json(
        { message: "Terlalu banyak percobaan. Coba lagi nanti." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
      );
    }

    const body = await parseJsonBody(request);
    const { name, email, password, address, role, storeName, errors } = validateRegister(body);
    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }

    const user = await registerUser({ name, email, password, address, role, storeName });
    await startSession(user.id);

    return Response.json({ user }, { status: 201 });
  } catch (e) {
    return handleApiError(e, "register");
  }
}

function handleApiError(e: unknown, route: string): Response {
  if (e instanceof ApiError) {
    return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
  }
  // Jangan pernah mencatat body/password — cukup nama & pesan error.
  console.error(`[api/auth/${route}]`, e instanceof Error ? `${e.name}: ${e.message}` : e);
  return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
}

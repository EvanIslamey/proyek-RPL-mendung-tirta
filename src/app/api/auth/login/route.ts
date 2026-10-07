import type { NextRequest } from "next/server";
import { authenticate, startSession } from "@/lib/auth";
import { clientIp, hitRateLimit } from "@/lib/rate-limit";
import { ApiError, assertSameOrigin, parseJsonBody, validateLogin } from "@/lib/validate";

/**
 * POST /api/auth/login — buat sesi login.
 * Pesan kegagalan selalu generik (tidak membocorkan keberadaan email).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);

    // Rate limit per-IP dulu sebelum memproses body.
    const ip = clientIp(request);
    const perIp = hitRateLimit(`login:ip:${ip}`, 30, 5 * 60_000);
    if (!perIp.ok) {
      return tooMany(perIp.retryAfterSeconds);
    }

    const body = await parseJsonBody(request);
    const { email, password, errors } = validateLogin(body);
    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }

    // Rate limit per-IP+email (anti brute force per akun target).
    const perTarget = hitRateLimit(`login:target:${ip}:${email}`, 5, 5 * 60_000);
    if (!perTarget.ok) {
      return tooMany(perTarget.retryAfterSeconds);
    }

    const user = await authenticate(email, password);
    if (!user) {
      throw new ApiError(401, "Email atau password salah.");
    }

    await startSession(user.id);
    return Response.json({ user });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/auth/login]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

function tooMany(retryAfterSeconds: number): Response {
  return Response.json(
    { message: "Terlalu banyak percobaan login. Coba lagi nanti." },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}

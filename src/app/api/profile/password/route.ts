import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { hashToken, requireUser, SESSION_COOKIE } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hitRateLimit } from "@/lib/rate-limit";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * POST /api/profile/password — ganti password milik sendiri.
 * Wajib: password lama benar + password baru valid.
 * Efek samping keamanan: sesi LAIN (device lain) ikut ditarik setelah ganti password.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();

    // Endpoint sensitif → batasi percobaan per akun (anti brute-force).
    const limit = hitRateLimit(`pw:${user.id}`, 10, 300_000);
    if (!limit.ok) {
      return Response.json(
        { message: `Terlalu banyak percobaan. Coba lagi dalam ${limit.retryAfterSeconds} detik.` },
        { status: 429 },
      );
    }

    const body = await parseJsonBody(request);

    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    const errors: Record<string, string> = {};
    if (!currentPassword) errors.currentPassword = "Password lama wajib diisi.";
    if (newPassword.length < 8) {
      errors.newPassword = "Password baru minimal 8 karakter.";
    } else if (newPassword.length > 72) {
      errors.newPassword = "Password baru maksimal 72 karakter.";
    } else if (newPassword === currentPassword) {
      errors.newPassword = "Password baru harus berbeda dari password lama.";
    }
    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, password: true },
    });
    if (!dbUser) throw new ApiError(401, "Sesi tidak valid. Silakan masuk kembali.");

    const valid = await bcrypt.compare(currentPassword, dbUser.password);
    if (!valid) {
      throw new ApiError(400, "Password lama salah.", {
        currentPassword: "Password lama salah.",
      });
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    // Tarik sesi lain (device lain) — sesi aktif saat ini tetap dipertahankan.
    const cookieStore = await cookies();
    const rawSession = cookieStore.get(SESSION_COOKIE)?.value;
    const tokenHash = rawSession ? hashToken(rawSession) : null;

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { password: hashed } }),
      prisma.session.deleteMany({
        where: {
          userId: user.id,
          ...(tokenHash ? { tokenHash: { not: tokenHash } } : {}),
        },
      }),
    ]);

    return Response.json({ message: "Password berhasil diubah." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/profile/password]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

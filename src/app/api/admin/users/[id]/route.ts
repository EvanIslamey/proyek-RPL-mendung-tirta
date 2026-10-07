import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

const ROLES = ["BUYER", "SELLER", "ADMIN"] as const;

/**
 * PATCH /api/admin/users/[id] — ubah role / status aktif pengguna.
 *
 * KEAMANAN:
 * - Admin TIDAK boleh mengubah akunnya sendiri (mencegah self-demote/lockout).
 * - Menurunkan role SELLER → BUYER/SELLER lain TIDAK menghapus toko yang sudah
 *   ada (riwayat & produk tetap utuh); menaikkan ke SELLER juga tidak membuat
 *   toko otomatis — seller dashboard punya alur buat toko sendiri.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const admin = await requireRole("ADMIN");
    const { id } = await params;

    if (id === admin.id) {
      throw new ApiError(400, "Tidak dapat mengubah akun sendiri.");
    }

    const body = await parseJsonBody(request);
    const roleRaw = body.role;
    const isActiveRaw = body.isActive;

    const errors: Record<string, string> = {};
    let role: (typeof ROLES)[number] | undefined;
    if (roleRaw !== undefined) {
      const value = typeof roleRaw === "string" ? roleRaw.trim().toUpperCase() : "";
      if ((ROLES as readonly string[]).includes(value)) {
        role = value as (typeof ROLES)[number];
      } else {
        errors.role = "Role tidak valid.";
      }
    }

    let isActive: boolean | undefined;
    if (isActiveRaw !== undefined) {
      if (typeof isActiveRaw === "boolean") {
        isActive = isActiveRaw;
      } else {
        errors.isActive = "Status aktif tidak valid.";
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }
    if (role === undefined && isActive === undefined) {
      throw new ApiError(400, "Tidak ada perubahan yang dikirim.");
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) throw new ApiError(404, "Pengguna tidak ditemukan.");

    await prisma.user.update({
      where: { id },
      data: {
        ...(role !== undefined ? { role } : {}),
        ...(isActive !== undefined ? { isActive } : {}),
      },
    });

    return Response.json({ message: "Pengguna diperbarui." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/users PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";

/**
 * GET /api/profile — profil user yang login (wajib login).
 */
export async function GET() {
  try {
    const user = await requireUser();
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        address: true,
        isActive: true,
        createdAt: true,
        _count: { select: { orders: true } },
      },
    });
    if (!dbUser) throw new ApiError(401, "Sesi tidak valid. Silakan masuk kembali.");

    return Response.json({
      profile: {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role,
        address: dbUser.address,
        orderCount: dbUser._count.orders,
        createdAt: dbUser.createdAt.toISOString(),
      },
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/profile GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PATCH /api/profile — ubah nama/alamat milik sendiri.
 * Email, role, dan password TIDAK bisa diubah lewat endpoint ini.
 */
export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const body = await parseJsonBody(request);

    const errors: Record<string, string> = {};
    const data: { name?: string; address?: string | null } = {};

    if (body.name !== undefined) {
      const name = asTrimmedString(body.name);
      if (name.length < 2 || name.length > 100) {
        errors.name = "Nama harus 2–100 karakter.";
      } else {
        data.name = name;
      }
    }
    if (body.address !== undefined) {
      const raw = body.address;
      const address = raw === null || raw === "" ? null : asTrimmedString(raw);
      if (address !== null && address.length > 255) {
        errors.address = "Alamat maksimal 255 karakter.";
      } else {
        data.address = address;
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }
    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "Tidak ada perubahan yang dikirim.");
    }

    await prisma.user.update({ where: { id: user.id }, data });
    return Response.json({ message: "Profil diperbarui." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/profile PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

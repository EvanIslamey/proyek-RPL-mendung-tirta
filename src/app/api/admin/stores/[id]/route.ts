import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * PATCH /api/admin/stores/[id] — aktifkan/nonaktifkan toko.
 * Menonaktifkan toko membuat produknya tak tampil di katalog publik
 * (filter `s.isActive = true` di lib/catalog).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireRole("ADMIN");
    const { id } = await params;

    const body = await parseJsonBody(request);
    if (typeof body.isActive !== "boolean") {
      throw new ApiError(400, "Data tidak valid.", {
        isActive: "Status toko harus boolean.",
      });
    }

    const store = await prisma.store.findUnique({ where: { id }, select: { id: true } });
    if (!store) throw new ApiError(404, "Toko tidak ditemukan.");

    await prisma.store.update({ where: { id }, data: { isActive: body.isActive } });

    return Response.json({
      message: body.isActive ? "Toko diaktifkan." : "Toko dinonaktifkan.",
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/stores PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

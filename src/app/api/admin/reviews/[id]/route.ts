import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin } from "@/lib/validate";

/**
 * DELETE /api/admin/reviews/[id] — hapus ulasan (moderasi konten).
 * Ulasan melekat pada produk/buyer, bukan "milik" admin — tetap role ADMIN
 * wajib dicek di backend.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireRole("ADMIN");
    const { id } = await params;

    const review = await prisma.review.findUnique({ where: { id }, select: { id: true } });
    if (!review) throw new ApiError(404, "Ulasan tidak ditemukan.");

    await prisma.review.delete({ where: { id } });
    return Response.json({ message: "Ulasan dihapus." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/reviews DELETE]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

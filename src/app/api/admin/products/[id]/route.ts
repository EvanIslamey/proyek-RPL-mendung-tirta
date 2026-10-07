import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";

const STATUSES = ["AVAILABLE", "OUT_OF_STOCK", "HIDDEN"] as const;

/**
 * PATCH /api/admin/products/[id] — moderasi status produk.
 * Admin HANYA boleh mengubah status (harga/stok tetap urusan penjual).
 * Body: { status: "AVAILABLE" | "OUT_OF_STOCK" | "HIDDEN" }
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
    const status = asTrimmedString(body.status).toUpperCase();
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new ApiError(400, "Data tidak valid.", { status: "Status tidak valid." });
    }

    const product = await prisma.product.findUnique({ where: { id }, select: { id: true } });
    if (!product) throw new ApiError(404, "Produk tidak ditemukan.");

    await prisma.product.update({ where: { id }, data: { status: status as never } });

    return Response.json({ message: "Status produk diperbarui." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/products PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

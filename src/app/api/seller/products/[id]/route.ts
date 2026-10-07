import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody, validateProductInput } from "@/lib/validate";
import { requireSellerStore } from "../route";

/**
 * Cek bahwa produk benar-benar milik toko user ini.
 * Anti-IDOR: tanpa ini, penjual bisa mengubah produk penjual lain.
 */
async function requireOwnProduct(userId: string, productId: string) {
  const store = await requireSellerStore(userId);
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, storeId: true },
  });
  if (!product || product.storeId !== store.id) {
    throw new ApiError(404, "Produk tidak ditemukan.");
  }
  return { store, product };
}

/**
 * PATCH /api/seller/products/[id] — ubah produk milik sendiri.
 * Body: campuran field (name, description, price, stock, image, categoryId, status).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireRole("SELLER");
    const { id } = await params;
    await requireOwnProduct(user.id, id);

    const body = await parseJsonBody(request);
    const input = validateProductInput(body, { partial: true });
    if (Object.keys(input.errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", input.errors);
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.price !== undefined) data.price = input.price;
    if (input.stock !== undefined) data.stock = input.stock;
    if (input.image !== undefined) data.image = input.image;
    if (input.categoryId !== undefined) data.categoryId = input.categoryId;
    if (input.status !== undefined) data.status = input.status;

    if (input.categoryId !== undefined) {
      const category = await prisma.category.findUnique({
        where: { id: input.categoryId },
        select: { id: true },
      });
      if (!category) {
        throw new ApiError(400, "Kategori tidak ditemukan.", {
          categoryId: "Kategori tidak ditemukan.",
        });
      }
    }

    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "Tidak ada perubahan yang dikirim.");
    }

    await prisma.product.update({ where: { id }, data });
    return Response.json({ message: "Produk diperbarui." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/seller/products PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * DELETE /api/seller/products/[id] — hapus produk milik sendiri.
 * Produk yang sudah pernah dipesan TIDAK dihapus (riwayat order), melainkan
 * disembunyikan (status HIDDEN) agar referensi order tetap utuh.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireRole("SELLER");
    const { id } = await params;
    await requireOwnProduct(user.id, id);

    const ordered = await prisma.orderItem.findFirst({
      where: { productId: id },
      select: { id: true },
    });

    if (ordered) {
      await prisma.product.update({ where: { id }, data: { status: "HIDDEN" } });
      return Response.json({
        message: "Produk pernah dipesan — disembunyikan dari katalog (riwayat tetap utuh).",
        hidden: true,
      });
    }

    await prisma.product.delete({ where: { id } });
    return Response.json({ message: "Produk dihapus.", hidden: false });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/seller/products DELETE]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

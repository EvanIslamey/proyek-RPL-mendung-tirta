import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody, validateProductInput } from "@/lib/validate";

/** Dapatkan store milik user SELLER yang login (atau 404). */
export async function requireSellerStore(userId: string) {
  const store = await prisma.store.findUnique({ where: { userId } });
  if (!store) {
    throw new ApiError(404, "Toko tidak ditemukan. Silakan buat toko terlebih dahulu.");
  }
  return store;
}

/**
 * GET /api/seller/products — daftar produk milik toko sendiri.
 * Query: q, status, page, limit.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireRole("SELLER");
    const store = await requireSellerStore(user.id);

    const sp = request.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim().slice(0, 100);
    const status = sp.get("status");
    const page = Math.min(1000, Math.max(1, Number(sp.get("page")) || 1));
    const limit = Math.min(48, Math.max(1, Number(sp.get("limit")) || 12));

    const where = {
      storeId: store.id,
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      ...(status && ["AVAILABLE", "OUT_OF_STOCK", "HIDDEN"].includes(status)
        ? { status: status as never }
        : {}),
    };

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          category: { select: { id: true, name: true } },
          _count: { select: { orderItems: true, reviews: true } },
          reviews: { select: { rating: true } },
        },
      }),
    ]);

    return Response.json({
      store: { id: store.id, storeName: store.storeName, isActive: store.isActive },
      items: products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: Number(p.price),
        stock: p.stock,
        image: p.image,
        status: p.status,
        category: { id: p.category.id, name: p.category.name },
        soldCount: p._count.orderItems,
        reviewCount: p._count.reviews,
        ratingAverage:
          p.reviews.length > 0
            ? Math.round((p.reviews.reduce((s, r) => s + r.rating, 0) / p.reviews.length) * 10) / 10
            : 0,
        createdAt: p.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/seller/products GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * POST /api/seller/products — tambah produk (wajib SELLER, milik toko sendiri).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireRole("SELLER");
    const store = await requireSellerStore(user.id);

    const body = await parseJsonBody(request);
    const input = validateProductInput(body);
    if (Object.keys(input.errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", input.errors);
    }
    // Guard narrow: setelah validasi lengkap, field wajib pasti terisi.
    if (
      input.name === undefined ||
      input.price === undefined ||
      input.stock === undefined ||
      input.categoryId === undefined
    ) {
      throw new ApiError(400, "Data tidak valid.", input.errors);
    }

    const category = await prisma.category.findUnique({
      where: { id: input.categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new ApiError(400, "Kategori tidak ditemukan.", {
        categoryId: "Kategori tidak ditemukan.",
      });
    }

    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        categoryId: input.categoryId,
        name: input.name,
        description: input.description,
        price: input.price,
        stock: input.stock,
        image: input.image,
        status: input.stock > 0 ? "AVAILABLE" : "OUT_OF_STOCK",
      },
    });

    return Response.json({ productId: product.id }, { status: 201 });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/seller/products POST]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

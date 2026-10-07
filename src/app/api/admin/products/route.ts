import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";

const STATUSES = ["AVAILABLE", "OUT_OF_STOCK", "HIDDEN"];

/**
 * GET /api/admin/products — daftar SEMUA produk lintas toko (khusus ADMIN).
 * Query: q, status, page, limit.
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const sp = request.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim().slice(0, 100);
    const status = (sp.get("status") ?? "").trim().toUpperCase();
    const page = Math.min(1000, Math.max(1, Number(sp.get("page")) || 1));
    const limit = Math.min(48, Math.max(1, Number(sp.get("limit")) || 12));

    const where = {
      ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}),
      ...(status && STATUSES.includes(status) ? { status: status as never } : {}),
    };

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          store: { select: { id: true, storeName: true } },
          category: { select: { id: true, name: true } },
          _count: { select: { reviews: true, orderItems: true } },
        },
      }),
    ]);

    return Response.json({
      items: products.map((p) => ({
        id: p.id,
        name: p.name,
        price: Number(p.price),
        stock: p.stock,
        image: p.image,
        status: p.status,
        store: { id: p.store.id, storeName: p.store.storeName },
        category: { id: p.category.id, name: p.category.name },
        reviewCount: p._count.reviews,
        soldCount: p._count.orderItems,
        createdAt: p.createdAt.toISOString(),
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/products GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

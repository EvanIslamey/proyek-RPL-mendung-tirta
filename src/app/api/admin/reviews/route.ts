import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";

/**
 * GET /api/admin/reviews — daftar semua ulasan (khusus ADMIN).
 * Query: page, limit.
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const sp = request.nextUrl.searchParams;
    const page = Math.min(1000, Math.max(1, Number(sp.get("page")) || 1));
    const limit = Math.min(48, Math.max(1, Number(sp.get("limit")) || 12));

    const where = {};

    const [total, reviews] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          product: { select: { id: true, name: true } },
          buyer: { select: { id: true, name: true } },
        },
      }),
    ]);

    return Response.json({
      items: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        product: { id: r.product.id, name: r.product.name },
        buyer: { id: r.buyer.id, name: r.buyer.name },
        createdAt: r.createdAt.toISOString(),
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
    console.error("[api/admin/reviews GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

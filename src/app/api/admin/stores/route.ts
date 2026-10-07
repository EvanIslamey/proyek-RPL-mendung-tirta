import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";

/**
 * GET /api/admin/stores — daftar semua toko (khusus ADMIN).
 * Query: q (cari nama toko/pemilik), isActive, page, limit.
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const sp = request.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim().slice(0, 100);
    const isActiveRaw = sp.get("isActive");
    const page = Math.min(1000, Math.max(1, Number(sp.get("page")) || 1));
    const limit = Math.min(48, Math.max(1, Number(sp.get("limit")) || 12));

    const isActive =
      isActiveRaw === "true" ? true : isActiveRaw === "false" ? false : undefined;

    const where = {
      ...(q
        ? {
            OR: [
              { storeName: { contains: q, mode: "insensitive" as const } },
              { user: { name: { contains: q, mode: "insensitive" as const } } },
              { user: { email: { contains: q, mode: "insensitive" as const } } },
            ],
          }
        : {}),
      ...(isActive !== undefined ? { isActive } : {}),
    };

    const [total, stores] = await Promise.all([
      prisma.store.count({ where }),
      prisma.store.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true, email: true } },
          _count: { select: { products: true } },
        },
      }),
    ]);

    return Response.json({
      items: stores.map((s) => ({
        id: s.id,
        storeName: s.storeName,
        description: s.description,
        location: s.location,
        isActive: s.isActive,
        owner: { id: s.user.id, name: s.user.name, email: s.user.email },
        productCount: s._count.products,
        createdAt: s.createdAt.toISOString(),
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
    console.error("[api/admin/stores GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

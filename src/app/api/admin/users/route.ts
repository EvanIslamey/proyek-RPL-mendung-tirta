import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";

const ROLES = ["ADMIN", "SELLER", "BUYER"];

/**
 * GET /api/admin/users — daftar semua pengguna (khusus ADMIN).
 * Query: q (cari nama/email), role, page, limit.
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const sp = request.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim().slice(0, 100);
    const role = (sp.get("role") ?? "").trim().toUpperCase();
    const page = Math.min(1000, Math.max(1, Number(sp.get("page")) || 1));
    const limit = Math.min(48, Math.max(1, Number(sp.get("limit")) || 12));

    const where = {
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(role && ROLES.includes(role) ? { role: role as never } : {}),
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { _count: { select: { orders: true } } },
      }),
    ]);

    return Response.json({
      items: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        address: u.address,
        isActive: u.isActive,
        createdAt: u.createdAt.toISOString(),
        orderCount: u._count.orders,
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
    console.error("[api/admin/users GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

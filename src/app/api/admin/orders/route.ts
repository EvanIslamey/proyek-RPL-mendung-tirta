import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";

const ALLOWED_STATUS = [
  "PENDING",
  "PROCESSING",
  "SHIPPED",
  "READY_FOR_PICKUP",
  "COMPLETED",
  "CANCELLED",
] as const;

/**
 * GET /api/admin/orders — daftar SEMUA pesanan (khusus ADMIN).
 * Query: status, page, limit.
 * Perubahan status pesanan dilakukan lewat PATCH /api/orders/[id]
 * (sudah mengizinkan ADMIN) — tidak diduplikasi di sini.
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");

    const sp = request.nextUrl.searchParams;
    const status = (sp.get("status") ?? "").trim().toUpperCase();
    const page = Math.min(1000, Math.max(1, Number(sp.get("page")) || 1));
    const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 12));

    const where = {
      ...(status && (ALLOWED_STATUS as readonly string[]).includes(status)
        ? { status: status as never }
        : {}),
    };

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          buyer: { select: { id: true, name: true, email: true } },
          payment: { select: { status: true } },
          orderItems: {
            select: {
              id: true,
              quantity: true,
              price: true,
              product: {
                select: {
                  id: true,
                  name: true,
                  store: { select: { id: true, storeName: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    return Response.json({
      items: orders.map((o) => ({
        id: o.id,
        status: o.status,
        total: Number(o.total),
        shippingAddress: o.shippingAddress,
        paymentStatus: o.payment?.status ?? null,
        buyer: { id: o.buyer.id, name: o.buyer.name, email: o.buyer.email },
        createdAt: o.createdAt.toISOString(),
        items: o.orderItems.map((i) => ({
          productId: i.product.id,
          name: i.product.name,
          storeName: i.product.store.storeName,
          quantity: i.quantity,
          price: Number(i.price),
        })),
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
    console.error("[api/admin/orders GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

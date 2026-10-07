import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";
import { requireSellerStore } from "../products/route";

const ALLOWED_STATUS = [
  "PENDING",
  "PROCESSING",
  "SHIPPED",
  "READY_FOR_PICKUP",
  "COMPLETED",
  "CANCELLED",
] as const;

/**
 * GET /api/seller/orders — pesanan yang BERISI produk toko penjual ini saja
 * (penjual tidak pernah melihat pesanan toko lain — filter by storeId).
 * Query: status (opsional), page, limit.
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireRole("SELLER");
    const store = await requireSellerStore(user.id);

    const sp = request.nextUrl.searchParams;
    const status = sp.get("status");
    const page = Math.min(1000, Math.max(1, Number(sp.get("page")) || 1));
    const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 12));

    const where = {
      orderItems: { some: { product: { storeId: store.id } } },
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
          buyer: { select: { name: true } },
          payment: { select: { status: true } },
          // Hanya item milik toko ini yang ditampilkan ke penjual.
          orderItems: {
            where: { product: { storeId: store.id } },
            include: { product: { select: { id: true, name: true, image: true } } },
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
        buyerName: o.buyer.name,
        createdAt: o.createdAt.toISOString(),
        items: o.orderItems.map((i) => ({
          productId: i.productId,
          name: i.product.name,
          image: i.product.image,
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
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/seller/orders]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

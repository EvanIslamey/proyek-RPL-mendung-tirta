import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { createOrder } from "@/lib/orders";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * POST /api/orders — checkout keranjang (wajib login).
 * Total & stok divalidasi/dihitung ulang di server (lihat lib/orders).
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const buyer = await requireUser();

    const body = await parseJsonBody(request);
    const items = Array.isArray(body.items) ? (body.items as unknown[]) : [];
    const shippingAddress =
      typeof body.shippingAddress === "string" ? body.shippingAddress.trim() : "";

    const { orderId } = await createOrder({
      buyer,
      items: items as { productId: string; quantity: number }[],
      shippingAddress,
    });

    return Response.json({ orderId }, { status: 201 });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/orders POST]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * GET /api/orders — daftar pesanan milik user yang login.
 * Query: status (opsional).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireUser();

    const statusFilter = request.nextUrl.searchParams.get("status");
    const allowed = ["PENDING", "PROCESSING", "SHIPPED", "READY_FOR_PICKUP", "COMPLETED", "CANCELLED"];

    const orders = await prisma.order.findMany({
      where: {
        buyerId: user.id,
        ...(statusFilter && allowed.includes(statusFilter) ? { status: statusFilter as never } : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        payment: { select: { status: true, method: true } },
        orderItems: {
          include: {
            product: { select: { name: true, image: true, store: { select: { storeName: true } } } },
          },
        },
      },
    });

    return Response.json({
      orders: orders.map((o) => ({
        id: o.id,
        status: o.status,
        total: Number(o.total),
        shippingAddress: o.shippingAddress,
        createdAt: o.createdAt.toISOString(),
        paymentStatus: o.payment?.status ?? null,
        items: o.orderItems.map((i) => ({
          productId: i.productId,
          name: i.product.name,
          image: i.product.image,
          storeName: i.product.store.storeName,
          quantity: i.quantity,
          price: Number(i.price),
        })),
      })),
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/orders GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

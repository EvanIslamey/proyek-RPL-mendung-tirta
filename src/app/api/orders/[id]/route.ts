import type { NextRequest } from "next/server";
import { requireRole, requireUser } from "@/lib/auth";
import { cancelOwnOrder, cancelOrderAs } from "@/lib/orders";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin } from "@/lib/validate";

async function loadOrderForView(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      payment: { select: { status: true, method: true, paidAt: true } },
      buyer: { select: { id: true, name: true, email: true } },
      orderItems: {
        include: {
          product: {
            select: {
              id: true,
              name: true,
              image: true,
              price: true,
              store: { select: { id: true, storeName: true } },
            },
          },
        },
      },
    },
  });
  return order;
}

/**
 * GET /api/orders/[id] — detail pesanan.
 * Pembeli hanya bisa melihat miliknya; penjual hanya order berisi produknya;
 * admin bisa semua.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const user = await requireUser();
    const order = await loadOrderForView(id);
    if (!order) return Response.json({ message: "Pesanan tidak ditemukan." }, { status: 404 });

    let allowed = order.buyerId === user.id || user.role === "ADMIN";
    if (!allowed && user.role === "SELLER") {
      const store = await prisma.store.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      allowed = order.orderItems.some((i) => i.product.store.id === store?.id);
    }
    if (!allowed) {
      return Response.json({ message: "Pesanan tidak ditemukan." }, { status: 404 });
    }

    return Response.json({
      order: {
        id: order.id,
        status: order.status,
        total: Number(order.total),
        shippingAddress: order.shippingAddress,
        createdAt: order.createdAt.toISOString(),
        updatedAt: order.updatedAt.toISOString(),
        paymentStatus: order.payment?.status ?? null,
        paymentMethod: order.payment?.method ?? null,
        paidAt: order.payment?.paidAt?.toISOString() ?? null,
        buyer: { id: order.buyer.id, name: order.buyer.name },
        items: order.orderItems.map((i) => ({
          productId: i.productId,
          name: i.product.name,
          image: i.product.image,
          storeId: i.product.store.id,
          storeName: i.product.store.storeName,
          quantity: i.quantity,
          price: Number(i.price),
        })),
      },
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/orders/[id] GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PATCH /api/orders/[id] — ubah status pesanan.
 * Body: { action: "cancel" } (pembeli, hanya PENDING)
 *       | { status: "..." } (penjual pemilik produk / admin, sesuai transisi).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const { id } = await params;
    const user = await requireRole("BUYER", "SELLER", "ADMIN");

    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const action = typeof body.action === "string" ? body.action : "";
    const newStatus = typeof body.status === "string" ? body.status : "";

    if (action === "cancel") {
      if (user.role === "BUYER") {
        await cancelOwnOrder(user, id);
      } else {
        const store = await prisma.store.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });
        await cancelOrderAs(user.role === "ADMIN" ? "ADMIN" : "SELLER", id, store?.id);
      }
      return Response.json({ message: "Pesanan dibatalkan." });
    }

    if (newStatus) {
      // Hanya admin/penjual yang mengubah status lanjutan.
      if (user.role === "BUYER") {
        throw new ApiError(403, "Pembeli tidak dapat mengubah status pesanan.");
      }

      const store = await prisma.store.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      const order = await prisma.order.findUnique({
        where: { id },
        include: { orderItems: { include: { product: { select: { storeId: true } } } } },
      });
      if (!order) throw new ApiError(404, "Pesanan tidak ditemukan.");

      const isOwnerSeller =
        user.role === "SELLER" && order.orderItems.some((i) => i.product.storeId === store?.id);
      if (user.role !== "ADMIN" && !isOwnerSeller) {
        throw new ApiError(404, "Pesanan tidak ditemukan.");
      }

      const { ORDER_TRANSITIONS } = await import("@/lib/orders");
      const allowedNext = ORDER_TRANSITIONS[order.status] ?? [];
      if (!allowedNext.includes(newStatus)) {
        throw new ApiError(409, `Transisi ${order.status} -> ${newStatus} tidak diizinkan.`);
      }

      if (newStatus === "CANCELLED") {
        await cancelOrderAs(user.role === "ADMIN" ? "ADMIN" : "SELLER", id, store?.id);
      } else {
        await prisma.order.update({ where: { id }, data: { status: newStatus as never } });
      }
      return Response.json({ message: `Status diperbarui ke ${newStatus}.` });
    }

    throw new ApiError(400, "Permintaan tidak valid.");
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/orders/[id] PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

import { Prisma } from "../../prisma/generated/client";
import { prisma } from "./prisma";
import { ApiError } from "./validate";
import type { SafeUser } from "./auth";

/** Transisi status order yang sah (untuk penjual/admin). */
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["SHIPPED", "READY_FOR_PICKUP", "CANCELLED"],
  SHIPPED: ["COMPLETED", "CANCELLED"],
  READY_FOR_PICKUP: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export type CheckoutItem = { productId: string; quantity: number };

export type OrderSummary = {
  id: string;
  status: string;
  total: number;
  shippingAddress: string;
  createdAt: string;
  paymentStatus: string | null;
};

/**
 * Checkout: buat order dari item keranjang.
 *
 * KEAMANAN & KONSISTENSI:
 * - Harga diambil dari database (bukan dari client) — total dihitung server.
 * - Stok divalidasi ulang lalu didekrementasi di dalam transaksi atomik:
 *   `updateMany` dengan syarat `stock >= qty` mencegah oversell secara
 *   bersamaan (baris yang di-lock DB tidak bisa didekrementasi dua kali
 *   hingga stok negatif).
 * - Gagal di satu item → seluruh transaksi dibatalkan (rollback).
 */
export async function createOrder(input: {
  buyer: SafeUser;
  items: CheckoutItem[];
  shippingAddress: string;
}): Promise<{ orderId: string }> {
  const { buyer, items, shippingAddress } = input;

  // Validasi bentuk input.
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "Keranjang kosong.", { items: "Keranjang kosong." });
  }
  if (items.length > 50) {
    throw new ApiError(400, "Terlalu banyak item dalam satu pesanan.");
  }
  if (shippingAddress.length < 5 || shippingAddress.length > 255) {
    throw new ApiError(400, "Alamat pengiriman harus 5–255 karakter.", {
      shippingAddress: "Alamat pengiriman harus 5–255 karakter.",
    });
  }

  // Gabungkan quantity per produk (mencegah double-entry).
  const qtyByProduct = new Map<string, number>();
  for (const item of items) {
    if (!item || typeof item.productId !== "string" || !item.productId) {
      throw new ApiError(400, "Item keranjang tidak valid.");
    }
    const qty = Number(item.quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      throw new ApiError(400, "Jumlah item tidak valid.", {
        quantity: "Jumlah item harus 1–999.",
      });
    }
    qtyByProduct.set(item.productId, (qtyByProduct.get(item.productId) ?? 0) + qty);
  }

  try {
    const orderId = await prisma.$transaction(async (tx) => {
      let total = new Prisma.Decimal(0);
      const validItems: { productId: string; quantity: number; price: Prisma.Decimal }[] = [];

      for (const [productId, quantity] of qtyByProduct) {
        const product = await tx.product.findUnique({
          where: { id: productId },
          select: { id: true, price: true, stock: true, status: true, name: true },
        });

        if (!product || product.status === "HIDDEN") {
          throw new ApiError(400, "Ada produk yang sudah tidak tersedia.", {
            items: "Ada produk yang sudah tidak tersedia.",
          });
        }
        if (product.status === "OUT_OF_STOCK" || product.stock < quantity) {
          throw new ApiError(
            409,
            `Stok "${product.name}" tidak mencukupi (tersisa ${product.stock}).`,
            { items: `Stok "${product.name}" tidak mencukupi (tersisa ${product.stock}).` },
          );
        }

        // Dekrementasi atomik: hanya bila stok masih mencukupi.
        const updated = await tx.product.updateMany({
          where: { id: productId, stock: { gte: quantity }, status: { not: "HIDDEN" } },
          data: { stock: { decrement: quantity } },
        });
        if (updated.count === 0) {
          throw new ApiError(409, `Stok "${product.name}" berubah saat diproses. Coba lagi.`, {
            items: `Stok "${product.name}" berubah saat diproses. Coba lagi.`,
          });
        }

        // Tandai OUT_OF_STOCK bila stok habis.
        if (product.stock - quantity <= 0) {
          await tx.product.update({
            where: { id: productId },
            data: { status: "OUT_OF_STOCK" },
          });
        }

        const price = product.price;
        total = total.plus(price.times(quantity));
        validItems.push({ productId, quantity, price });
      }

      const order = await tx.order.create({
        data: {
          buyerId: buyer.id,
          total,
          status: "PENDING",
          shippingAddress,
          orderItems: {
            create: validItems.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              price: i.price,
            })),
          },
          payment: {
            create: { amount: total, method: "dummy", status: "PENDING" },
          },
        },
        select: { id: true },
      });

      return order.id;
    });

    return { orderId };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    console.error("[orders/createOrder]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    throw new ApiError(500, "Gagal memproses pesanan. Coba lagi.");
  }
}

/**
 * Bayar order (MVP: dummy). Hanya order PENDING milik pembeli yang bisa dibayar.
 * Membayar mengubah payment -> PAID dan order -> PROCESSING.
 */
export async function payOrder(user: SafeUser, orderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });

    if (!order || order.buyerId !== user.id) {
      throw new ApiError(404, "Pesanan tidak ditemukan.");
    }
    if (order.status !== "PENDING") {
      throw new ApiError(409, "Pesanan ini tidak menunggu pembayaran.");
    }

    await tx.payment.updateMany({
      where: { orderId, status: "PENDING" },
      data: { status: "PAID", paidAt: new Date() },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { status: "PROCESSING" },
    });
  });
}

/** Batalkan order oleh pembeli (hanya status PENDING) + kembalikan stok. */
export async function cancelOwnOrder(user: SafeUser, orderId: string): Promise<void> {
  const owned = await prisma.order.findUnique({
    where: { id: orderId },
    select: { buyerId: true },
  });
  if (!owned || owned.buyerId !== user.id) {
    throw new ApiError(404, "Pesanan tidak ditemukan.");
  }
  await cancelOrderCore(orderId, ["PENDING"], true);
}

/** Batalkan order oleh penjual/admin + kembalikan stok. */
export async function cancelOrderAs(
  role: "SELLER" | "ADMIN",
  orderId: string,
  storeId?: string,
): Promise<void> {
  if (role === "SELLER") {
    // Penjual hanya boleh membatalkan order yang berisi produk tokonya.
    const hasOwnItem = await prisma.orderItem.findFirst({
      where: { orderId, product: { storeId: storeId ?? "" } },
      select: { id: true },
    });
    if (!hasOwnItem) throw new ApiError(404, "Pesanan tidak berisi produk Anda.");
  }
  await cancelOrderCore(
    orderId,
    ["PENDING", "PROCESSING", "SHIPPED", "READY_FOR_PICKUP"],
    true,
  );
}

async function cancelOrderCore(
  orderId: string,
  allowedStatuses: string[],
  restock: boolean,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { orderItems: true, payment: true },
    });
    if (!order) throw new ApiError(404, "Pesanan tidak ditemukan.");
    if (!allowedStatuses.includes(order.status)) {
      throw new ApiError(409, `Pesanan dengan status ${order.status} tidak dapat dibatalkan.`);
    }

    if (restock) {
      for (const item of order.orderItems) {
        const updated = await tx.product.updateMany({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
        if (updated.count > 0) {
          // Kembalikan status bila sebelumnya OUT_OF_STOCK.
          await tx.product.updateMany({
            where: { id: item.productId, stock: { gt: 0 }, status: "OUT_OF_STOCK" },
            data: { status: "AVAILABLE" },
          });
        }
      }
    }

    await tx.order.update({ where: { id: orderId }, data: { status: "CANCELLED" } });
    if (order.payment && order.payment.status === "PENDING") {
      await tx.payment.update({
        where: { id: order.payment.id },
        data: { status: "FAILED" },
      });
    }
  });
}

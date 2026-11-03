import { Prisma } from "../../prisma/generated/client";
import { prisma } from "./prisma";
import { ApiError } from "./validate";
import type { SafeUser } from "./auth";
import { dispatchEmails, notifyInTx, type NotifyInput } from "./notify";
import { stockAlertThreshold } from "./ai-context";

const rupiah = (n: number): string => `Rp${Math.round(n).toLocaleString("id-ID")}`;

/**
 * Buat notifikasi identik ke SEMUA admin aktif DALAM transaksi `tx` dan
 * kumpulkan id-nya ke `notifyIds` (in-app + email; WhatsApp operasional hanya
 * dikirim dari SATU baris admin — aturan anti ganda ada di resolveWaEligibility).
 */
async function pushAdminNotices(
  tx: Prisma.TransactionClient,
  notifyIds: string[],
  notice: Omit<NotifyInput, "userId">,
): Promise<void> {
  const admins = await tx.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  for (const a of admins) {
    const id = await notifyInTx(tx, { ...notice, userId: a.id });
    if (id) notifyIds.push(id);
  }
}

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
    const notifyIds: string[] = [];
    const lowStockHits: { productId: string; name: string; stock: number; storeUserId: string }[] = [];
    const qtyNames = new Map<string, { name: string; quantity: number }>();
    const threshold = stockAlertThreshold();

    const orderId = await prisma.$transaction(async (tx) => {
      let total = new Prisma.Decimal(0);
      const validItems: { productId: string; quantity: number; price: Prisma.Decimal }[] = [];

      for (const [productId, quantity] of qtyByProduct) {
        const product = await tx.product.findUnique({
          where: { id: productId },
          select: {
            id: true,
            price: true,
            stock: true,
            status: true,
            name: true,
            store: { select: { userId: true, storeName: true } },
          },
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

        // Stok menyentuh/masuk ambang menipis? → catat untuk notifikasi seller.
        const newStock = product.stock - quantity;
        if (newStock >= 0 && newStock <= threshold) {
          lowStockHits.push({
            productId,
            name: product.name,
            stock: newStock,
            storeUserId: product.store.userId,
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
        qtyNames.set(productId, { name: product.name, quantity });
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
        select: { id: true, total: true },
      });

      /* --- Notifikasi dibuat DALAM transaksi (ikut rollback bila gagal) --- */
      const push = async (p: Promise<string | null>) => {
        const id = await p;
        if (id) notifyIds.push(id);
      };
      const shortId = order.id.slice(0, 8);
      const itemLines = validItems.map((i) => {
        const p = qtyNames.get(i.productId);
        return `${p?.name ?? "Produk"} x${p?.quantity ?? i.quantity}`;
      });

      // 1. Pembeli: konfirmasi pesanan.
      await push(
        notifyInTx(tx, {
          userId: buyer.id,
          kind: "ORDER_CREATED",
          title: `Pesanan #${shortId} berhasil dibuat`,
          body: [
            `Total: ${rupiah(Number(order.total))} — status: PENDING (menunggu pembayaran).`,
            "Item:",
            ...itemLines,
            `Dikirim ke: ${shippingAddress}`,
          ].join("\n"),
          link: `/orders/${order.id}`,
          dedupeKey: `order:${order.id}:created`,
        }),
      );

      // 2. Penjual terkait: pesanan baru masuk (per toko).
      const orderItems = await tx.orderItem.findMany({
        where: { orderId: order.id },
        include: {
          product: { select: { name: true, store: { select: { userId: true, storeName: true } } } },
        },
      });
      const bySeller = new Map<string, { storeName: string; lines: string[] }>();
      for (const it of orderItems) {
        const g = bySeller.get(it.product.store.userId) ?? {
          storeName: it.product.store.storeName,
          lines: [],
        };
        g.lines.push(`${it.product.name} x${it.quantity}`);
        bySeller.set(it.product.store.userId, g);
      }
      for (const [sellerId, g] of bySeller) {
        await push(
          notifyInTx(tx, {
            userId: sellerId,
            kind: "ORDER_CREATED",
            title: `Pesanan baru berisi produk Anda (#${shortId})`,
            body: [
              `${buyer.name} memesan produk toko "${g.storeName}":`,
              ...g.lines,
              `Nilai total pesanan: ${rupiah(Number(order.total))}`,
              "Status: PENDING (menunggu pembayaran).",
            ].join("\n"),
            link: "/seller/orders",
            dedupeKey: `order:${order.id}:seller:${sellerId}`,
          }),
        );
      }

      // 3. Stok menipis (email NON-esensial → hormati preferensi penjual).
      for (const hit of lowStockHits) {
        await push(
          notifyInTx(tx, {
            userId: hit.storeUserId,
            kind: "STOCK_LOW",
            title: `Stok "${hit.name}" menipis (tersisa ${hit.stock})`,
            body: `Setelah pesanan baru, stok "${hit.name}" tinggal ${hit.stock} (ambang peringatan: ${threshold}). Segera restok agar tidak kehabisan.`,
            link: "/seller/products",
            dedupeKey: `stock:${hit.productId}:${hit.stock}`,
            essential: false,
          }),
        );
      }

      // 4. Admin: pesanan baru (in-app; WA operasional bila penerima dikonfigurasi).
      await pushAdminNotices(tx, notifyIds, {
        kind: "ORDER_CREATED",
        title: `Pesanan baru #${shortId}`,
        body: [
          `${buyer.name} memesan ${validItems.length} item senilai ${rupiah(Number(order.total))}.`,
          "Item:",
          ...itemLines,
          `Dikirim ke: ${shippingAddress}`,
          "Status: PENDING (menunggu pembayaran).",
        ].join("\n"),
        link: "/admin/orders",
        dedupeKey: `order:${order.id}:admin:created`,
      });

      return order.id;
    });

    // Transaksi COMMIT → kirim email (kegagalan di sini tidak membatalkan pesanan).
    void dispatchEmails(notifyIds);

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
 * Notifikasi: pembeli (pembayaran diterima) + penjual (pesanan menunggu tindakan).
 */
export async function payOrder(user: SafeUser, orderId: string): Promise<void> {
  const notifyIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        payment: true,
        orderItems: {
          include: {
            product: { select: { name: true, store: { select: { userId: true, storeName: true } } } },
          },
        },
      },
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

    /* Notifikasi DALAM transaksi — dispatch setelah commit. */
    const push = async (p: Promise<string | null>) => {
      const id = await p;
      if (id) notifyIds.push(id);
    };
    const shortId = order.id.slice(0, 8);

    await push(
      notifyInTx(tx, {
        userId: order.buyerId,
        kind: "PAYMENT_CONFIRMED",
        title: `Pembayaran pesanan #${shortId} diterima`,
        body: [
          `Pembayaran ${rupiah(Number(order.payment?.amount ?? order.total))} untuk pesanan #${shortId} telah diterima.`,
          "Status pesanan kini PROCESSING (diproses penjual).",
        ].join("\n"),
        link: `/orders/${order.id}`,
        dedupeKey: `order:${order.id}:paid`,
      }),
    );

    // Penjual terkait: pesanan menunggu tindakan (proses/kirim).
    const bySeller = new Map<string, { storeName: string; lines: string[] }>();
    for (const it of order.orderItems) {
      const g = bySeller.get(it.product.store.userId) ?? {
        storeName: it.product.store.storeName,
        lines: [],
      };
      g.lines.push(`${it.product.name} x${it.quantity}`);
      bySeller.set(it.product.store.userId, g);
    }
    for (const [sellerId, g] of bySeller) {
      await push(
        notifyInTx(tx, {
          userId: sellerId,
          kind: "ORDER_STATUS_CHANGED",
          title: `Pesanan #${shortId} sudah dibayar — menunggu diproses`,
          body: [
            `Pembayaran diterima untuk pesanan berisi produk "${g.storeName}":`,
            ...g.lines,
            "Status kini PROCESSING — silakan proses pesanan.",
          ].join("\n"),
          link: "/seller/orders",
          dedupeKey: `order:${order.id}:status:PROCESSING:seller:${sellerId}`,
        }),
      );
    }

    // Admin: pembayaran dikonfirmasi (in-app; WA operasional bila dikonfigurasi).
    await pushAdminNotices(tx, notifyIds, {
      kind: "PAYMENT_CONFIRMED",
      title: `Pembayaran pesanan #${shortId} dikonfirmasi`,
      body: [
        `Pembayaran ${rupiah(Number(order.payment?.amount ?? order.total))} untuk pesanan #${shortId} diterima.`,
        "Status pesanan kini PROCESSING (diproses penjual).",
      ].join("\n"),
      link: "/admin/orders",
      dedupeKey: `order:${order.id}:admin:paid`,
    });
  });

  void dispatchEmails(notifyIds);
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
  const notifyIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        payment: true,
        orderItems: {
          include: {
            product: { select: { name: true, store: { select: { userId: true, storeName: true } } } },
          },
        },
      },
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

    /* Notifikasi pembatalan DALAM transaksi. */
    const push = async (p: Promise<string | null>) => {
      const id = await p;
      if (id) notifyIds.push(id);
    };
    const shortId = order.id.slice(0, 8);

    await push(
      notifyInTx(tx, {
        userId: order.buyerId,
        kind: "ORDER_STATUS_CHANGED",
        title: `Pesanan #${shortId} dibatalkan`,
        body: `Pesanan #${shortId} berstatus CANCELLED.${restock ? " Stok produk telah dikembalikan." : ""}`,
        link: `/orders/${order.id}`,
        dedupeKey: `order:${order.id}:status:CANCELLED`,
      }),
    );

    const sellerIds = new Set(order.orderItems.map((i) => i.product.store.userId));
    for (const sellerId of sellerIds) {
      await push(
        notifyInTx(tx, {
          userId: sellerId,
          kind: "ORDER_STATUS_CHANGED",
          title: `Pesanan #${shortId} dibatalkan`,
          body: `Pesanan berisi produk Anda (#${shortId}) kini CANCELLED.${restock ? " Stok telah dikembalikan." : ""}`,
          link: "/seller/orders",
          dedupeKey: `order:${order.id}:status:CANCELLED:seller:${sellerId}`,
        }),
      );
    }

    // Admin: pembatalan pesanan (aktivitas penting marketplace).
    await pushAdminNotices(tx, notifyIds, {
      kind: "ORDER_STATUS_CHANGED",
      title: `Pesanan #${shortId} dibatalkan`,
      body: `Pesanan #${shortId} senilai ${rupiah(Number(order.total))} kini CANCELLED.${restock ? " Stok produk telah dikembalikan." : ""}`,
      link: "/admin/orders",
      dedupeKey: `order:${order.id}:admin:cancelled`,
    });
  });

  void dispatchEmails(notifyIds);
}

/** Label status Indonesia untuk isi email/notifikasi. */
const STATUS_LABEL_ID: Record<string, string> = {
  PENDING: "menunggu pembayaran",
  PROCESSING: "sedang diproses penjual",
  SHIPPED: "sudah dikirim",
  READY_FOR_PICKUP: "siap diambil di toko",
  COMPLETED: "selesai",
  CANCELLED: "dibatalkan",
};

/**
 * Ubah status pesanan non-pembatalan (transisi SAH sudah divalidasi pemanggil
 * lewat ORDER_TRANSITIONS + cek kepemilikan di route). Notifikasi pembeli
 * dibuat dalam transaksi yang sama; email dikirim setelah commit.
 */
export async function setOrderStatus(orderId: string, newStatus: string): Promise<void> {
  const notifyIds: string[] = [];

  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        buyerId: true,
        status: true,
        orderItems: {
          select: { product: { select: { store: { select: { userId: true } } } } },
        },
      },
    });
    if (!order) throw new ApiError(404, "Pesanan tidak ditemukan.");
    if (order.status === newStatus) {
      throw new ApiError(409, "Status pesanan sama dengan status saat ini.");
    }

    await tx.order.update({ where: { id: orderId }, data: { status: newStatus as never } });

    const shortId = order.id.slice(0, 8);
    const id = await notifyInTx(tx, {
      userId: order.buyerId,
      kind: "ORDER_STATUS_CHANGED",
      title: `Pesanan #${shortId} kini ${STATUS_LABEL_ID[newStatus] ?? newStatus}`,
      body: [
        `Status pesanan #${shortId} diperbarui: ${order.status} → ${newStatus}`,
        `Artinya: ${STATUS_LABEL_ID[newStatus] ?? newStatus}.`,
      ].join("\n"),
      link: `/orders/${order.id}`,
      dedupeKey: `order:${order.id}:status:${newStatus}`,
    });
    if (id) notifyIds.push(id);

    // Penjual terkait: perubahan status pesanan (proses/kirim/selesai).
    const sellerIds = new Set(order.orderItems.map((i) => i.product.store.userId));
    for (const sellerId of sellerIds) {
      const sid = await notifyInTx(tx, {
        userId: sellerId,
        kind: "ORDER_STATUS_CHANGED",
        title: `Pesanan #${shortId} kini ${STATUS_LABEL_ID[newStatus] ?? newStatus}`,
        body: `Pesanan berisi produk Anda (#${shortId}) diperbarui: ${order.status} → ${newStatus} (${STATUS_LABEL_ID[newStatus] ?? newStatus}).`,
        link: "/seller/orders",
        dedupeKey: `order:${order.id}:status:${newStatus}:seller:${sellerId}`,
      });
      if (sid) notifyIds.push(sid);
    }

    // Admin: perubahan status non-pembatalan (aktivitas penting).
    await pushAdminNotices(tx, notifyIds, {
      kind: "ORDER_STATUS_CHANGED",
      title: `Pesanan #${shortId} kini ${STATUS_LABEL_ID[newStatus] ?? newStatus}`,
      body: `Status pesanan #${shortId} diperbarui: ${order.status} → ${newStatus} (${STATUS_LABEL_ID[newStatus] ?? newStatus}).`,
      link: "/admin/orders",
      dedupeKey: `order:${order.id}:admin:status:${newStatus}`,
    });
  });

  void dispatchEmails(notifyIds);
}

import { Prisma } from "../../../../../prisma/generated/client";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";
import { requireSellerStore } from "../products/route";

/**
 * GET /api/seller/stats — ringkasan dashboard penjual:
 * jumlah produk, pendapatan, pesanan, rating, dsb.
 */
export async function GET() {
  try {
    const user = await requireRole("SELLER");
    const store = await requireSellerStore(user.id);

    const [totalProducts, activeProducts, outOfStock, reviewAgg, orderStatusRows, revenueRows, recentOrders] =
      await Promise.all([
        prisma.product.count({ where: { storeId: store.id } }),
        prisma.product.count({ where: { storeId: store.id, status: "AVAILABLE" } }),
        prisma.product.count({ where: { storeId: store.id, status: "OUT_OF_STOCK" } }),
        prisma.review.aggregate({
          where: { product: { storeId: store.id } },
          _avg: { rating: true },
          _count: true,
        }),
        // Pesanan yang berisi produk toko ini, dikelompokkan per status.
        prisma.$queryRaw<{ status: string; count: number }[]>(Prisma.sql`
          SELECT o.status::text AS status, COUNT(DISTINCT o.id)::int AS count
          FROM "Order" o
          JOIN "OrderItem" oi ON oi."orderId" = o.id
          JOIN "Product" p ON p.id = oi."productId"
          WHERE p."storeId" = ${store.id}
          GROUP BY o.status
        `),
        // Pendapatan dari item toko ini pada pesanan yang sudah dibayar/diproses.
        prisma.$queryRaw<{ revenue: string | number; sold: number }[]>(Prisma.sql`
          SELECT COALESCE(SUM(oi.price * oi.quantity), 0)::float AS revenue,
                 COALESCE(SUM(oi.quantity), 0)::int AS sold
          FROM "OrderItem" oi
          JOIN "Order" o ON o.id = oi."orderId"
          JOIN "Product" p ON p.id = oi."productId"
          WHERE p."storeId" = ${store.id}
            AND o.status IN ('PROCESSING', 'SHIPPED', 'READY_FOR_PICKUP', 'COMPLETED')
        `),
        prisma.order.findMany({
          where: { orderItems: { some: { product: { storeId: store.id } } } },
          orderBy: { createdAt: "desc" },
          take: 5,
          select: {
            id: true,
            status: true,
            total: true,
            createdAt: true,
            buyer: { select: { name: true } },
          },
        }),
      ]);

    const ordersByStatus: Record<string, number> = {};
    for (const row of orderStatusRows) ordersByStatus[row.status] = row.count;
    const totalOrders = orderStatusRows.reduce((sum, r) => sum + r.count, 0);

    return Response.json({
      store: { id: store.id, storeName: store.storeName, isActive: store.isActive },
      products: { total: totalProducts, active: activeProducts, outOfStock },
      orders: {
        total: totalOrders,
        byStatus: ordersByStatus,
        pending: ordersByStatus.PENDING ?? 0,
        processing: ordersByStatus.PROCESSING ?? 0,
        completed: ordersByStatus.COMPLETED ?? 0,
      },
      sales: {
        revenue: Number(revenueRows[0]?.revenue ?? 0),
        soldItems: revenueRows[0]?.sold ?? 0,
      },
      rating: {
        average: Math.round((reviewAgg._avg.rating ?? 0) * 10) / 10,
        count: reviewAgg._count,
      },
      recentOrders: recentOrders.map((o) => ({
        id: o.id,
        status: o.status,
        total: Number(o.total),
        buyerName: o.buyer.name,
        createdAt: o.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/seller/stats]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

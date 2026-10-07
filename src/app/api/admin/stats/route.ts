import { Prisma } from "../../../../../prisma/generated/client";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/validate";

/**
 * GET /api/admin/stats — ringkasan global untuk dashboard admin:
 * jumlah user per role, toko, produk per status, pesanan per status,
 * total pendapatan, dan ulasan (jumlah + rata-rata rating).
 */
export async function GET() {
  try {
    await requireRole("ADMIN");

    const [userRoleRows, storeRows, productRows, orderRows, revenueRows, reviewAgg] =
      await Promise.all([
        prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
        prisma.store.groupBy({ by: ["isActive"], _count: { _all: true } }),
        prisma.product.groupBy({ by: ["status"], _count: { _all: true } }),
        // Pesanan dikelompokkan per status (contoh pola $queryRaw di seller/stats).
        prisma.$queryRaw<{ status: string; count: number }[]>(Prisma.sql`
          SELECT o.status::text AS status, COUNT(*)::int AS count
          FROM "Order" o
          GROUP BY o.status
        `),
        // Pendapatan dari pesanan yang sudah diproses/diselesaikan.
        prisma.$queryRaw<{ revenue: string | number }[]>(Prisma.sql`
          SELECT COALESCE(SUM(oi.price * oi.quantity), 0)::float AS revenue
          FROM "OrderItem" oi
          JOIN "Order" o ON o.id = oi."orderId"
          WHERE o.status IN ('PROCESSING', 'SHIPPED', 'READY_FOR_PICKUP', 'COMPLETED')
        `),
        prisma.review.aggregate({ _count: { _all: true }, _avg: { rating: true } }),
      ]);

    const usersByRole: Record<string, number> = { ADMIN: 0, SELLER: 0, BUYER: 0 };
    for (const row of userRoleRows) usersByRole[row.role] = row._count._all;
    const usersTotal = Object.values(usersByRole).reduce((sum, n) => sum + n, 0);

    const stores = { total: 0, active: 0, inactive: 0 };
    for (const row of storeRows) {
      stores.total += row._count._all;
      if (row.isActive) stores.active = row._count._all;
      else stores.inactive = row._count._all;
    }

    const productsByStatus: Record<string, number> = { AVAILABLE: 0, OUT_OF_STOCK: 0, HIDDEN: 0 };
    for (const row of productRows) productsByStatus[row.status] = row._count._all;
    const productsTotal = Object.values(productsByStatus).reduce((sum, n) => sum + n, 0);

    const ordersByStatus: Record<string, number> = {};
    for (const row of orderRows) ordersByStatus[row.status] = row.count;
    const ordersTotal = orderRows.reduce((sum, r) => sum + r.count, 0);

    return Response.json({
      users: { total: usersTotal, byRole: usersByRole },
      stores,
      products: { total: productsTotal, byStatus: productsByStatus },
      orders: { total: ordersTotal, byStatus: ordersByStatus },
      revenue: Number(revenueRows[0]?.revenue ?? 0),
      reviews: {
        total: reviewAgg._count._all,
        average: Math.round((reviewAgg._avg.rating ?? 0) * 10) / 10,
      },
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/stats]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

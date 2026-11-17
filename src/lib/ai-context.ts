/**
 * Repository layer pengambilan konteks chatbot dari database (Fitur A).
 *
Prinsip keamanan (A3/A4):
 * - Query SELALU dijalankan di backend dengan identitas dari sesi login
 *   (`SafeUser`) — tidak pernah mempercayai role/user ID dari frontend.
 * - Model AI TIDAK PERNAH menulis SQL: dia hanya menerima teks hasil fetch
 *   ini sebagai konteks. Retrieval murni kode terprogram (bukan tool call
 *   yang dieksekusi model).
 * - Setiap fetcher membatasi jumlah baris (≤10) dan meminimalkan PII
 *   (tanpa email/password/alamat pihak lain; pesanan hanya milik sendiri /
 *   toko sendiri sesuai peran).
 * - Intent dideteksi deterministik dari kata kunci → daftar fetcher yang
 *   boleh berjalan dibatasi peran (BUYER/SELLER/ADMIN).
 *
 * Data diambil SAAT pertanyaan diajukan (query terkini, bukan embedding).
 */

import { Prisma } from "../../prisma/generated/client";
import { prisma } from "./prisma";
import { cached } from "./ai-cache";
import {
  searchCatalog,
  findFocusProducts,
  countCatalog,
  extractKeywords,
  extractSubjectPhrase,
  resolveProductSubject,
  parseProductFilters,
  describePriceFilterText,
  isSingleProductQuestion,
  NON_CATALOG_INTENTS,
  type AiProduct,
  type ChatbotIntent,
  type ProductFilter,
  type ProductSubject,
} from "./ai";
import {
  classifyChatbotIntent,
  detectIntents,
  detectCountQuery,
  detectUserListTarget,
  detectBuyersOfProduct,
  detectProductExtremes,
  STORE_RANK_RE,
  mergeIntentParams,
  type CountKind,
} from "./ai-intent";
import type { SafeUser } from "./auth";

// Kompatibilitas: deteksi intent tetap bisa diimpor dari modul ini
// (sumber kebenarannya kini ./ai-intent — satu definisi untuk semua).
export { detectIntents, detectCountQuery } from "./ai-intent";
export type { ChatIntent, CountKind } from "./ai-intent";

export type ContextScope = "publik" | "milik-sendiri" | "toko-sendiri" | "admin";

export type ContextSection = {
  key:
    | "orders"
    | "sales"
    | "stats"
    | "market"
    | "count"
    | "extremes"
    | "revenue"
    | "lowstock"
    | "outofstock"
    | "store"
    | "account"
    | "roles"
    | "userlist"
    | "catalog"
    | "reviews"
    | "appinfo";
  label: string;
  scope: ContextScope;
  asOf: string; // ISO waktu pengambilan (untuk sumber/jawaban "diperbarui saat…")
  text: string; // data terformat (human-readable) untuk prompt & fallback
};

export type ChatContext = {
  products: AiProduct[];
  sections: ContextSection[];
  /** Produk dari riwayat percakapan (divalidasi ulang dari DB). */
  contextProducts: AiProduct[];
  /** Produk fokus (satu nama cocok / konteks lanjutan) — divalidasi dari DB. */
  focus: AiProduct | null;
  /** ≥2 nama produk cocok dengan keyword → jawab dengan klarifikasi. */
  focusCandidates: AiProduct[];
  /** Pertanyaan lanjutan ("berapa harganya?") tanpa referensi jelas → klarifikasi. */
  ambiguousFollowUp: boolean;
  /**
   * Filter gabungan FINAL (harga, subjek, kategori, toko, stok, rating,
   * sorting) — sudah termasuk subjek hasil resolve/retensi dari riwayat.
   * Dipakai route untuk generateReply (satu sumber kebenaran).
   */
  filters: ProductFilter;
  /** Frasa subjek ambigu antar kategori → wajib minta klarifikasi user. */
  subjectAmbiguity?: { phrase: string; options: string[] };
  /** Intent klasifikasi utama (taksonomi CHATBOT_INTENTS) — hasil classifyChatbotIntent. */
  intent: ChatbotIntent;
  generatedAt: string;
};

/** Ambang stok menipis — dapat dikonfigurasi via env (default 5). */
export function stockAlertThreshold(): number {
  const raw = (process.env.STOCK_ALERT_THRESHOLD ?? "").trim();
  if (!raw) return 5; // Number("") === 0 — harus ditangani sebelum konversi
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}

const fmtDate = (d: Date): string =>
  d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const rupiah = (n: number): string => `Rp${Math.round(n).toLocaleString("id-ID")}`;

/* ------------------------------------------------------------------ */
/* Fetcher per topik — semua parameterized Prisma, dibatasi per peran. */
/* ------------------------------------------------------------------ */

/** Pesanan pembeli: milik sendiri saja (termasuk akun admin saat berbelanja
 *  dengan rujukan "pesanan saya"). Tanpa rujukan sendiri, ADMIN melihat
 *  pesanan TERBARU seluruh marketplace (data operasional) — penjual tetap
 *  hanya order berisi produk toko. Tanpa email/PII selain nama pembeli. */
export async function fetchOrders(
  user: SafeUser,
  message: string,
): Promise<ContextSection | null> {
  const asOf = new Date().toISOString();
  // Rujukan milik sendiri ("pesanan saya") → jalur pesanan sendiri untuk SEMUA
  // peran; tanpa itu, pertanyaan umum ("tampilkan pesanan terbaru") untuk admin
  // = cakupan marketplace.
  const wantsOwn =
    user.role === "BUYER" ||
    (user.role === "ADMIN" &&
      /\b(?:saya|aku|sendiri|milik\s+(?:saya|anda)|akun\s+saya|order\s+saya)\b/i.test(message));

  if (wantsOwn) {
    const orders = await prisma.order.findMany({
      where: { buyerId: user.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        payment: { select: { status: true } },
        orderItems: {
          include: { product: { select: { name: true, store: { select: { storeName: true } } } } },
        },
      },
    });
    if (orders.length === 0) return null;

    const text = orders
      .map((o) => {
        const items = o.orderItems
          .map((i) => `${i.product.name} x${i.quantity} (${i.product.store.storeName})`)
          .join(", ");
        return (
          `#${o.id.slice(0, 8)} | ${fmtDate(o.createdAt)} | status: ${o.status}` +
          ` | bayar: ${o.payment?.status ?? "-"} | total: ${rupiah(Number(o.total))}` +
          ` | item: ${items}`
        );
      })
      .join("\n");

    return {
      key: "orders",
      label:
        user.role === "ADMIN"
          ? `Pesanan Anda (admin, ${orders.length} terbaru)`
          : `Pesanan pembeli yang sedang login (${orders.length} terbaru)`,
      scope: "milik-sendiri",
      asOf,
      text,
    };
  }

  // ADMIN tanpa rujukan milik sendiri → pesanan terbaru SELURUH marketplace
  // (data operasional yang berwenang diminta admin).
  if (user.role === "ADMIN") {
    const orders = await prisma.order.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      include: {
        buyer: { select: { name: true } },
        payment: { select: { status: true } },
        orderItems: {
          include: { product: { select: { name: true, store: { select: { storeName: true } } } } },
        },
      },
    });
    if (orders.length === 0) return null;

    const text = orders
      .map((o) => {
        const items = o.orderItems
          .map((i) => `${i.product.name} x${i.quantity} (${i.product.store.storeName})`)
          .join(", ");
        return (
          `#${o.id.slice(0, 8)} | ${fmtDate(o.createdAt)} | pembeli: ${o.buyer.name}` +
          ` | status: ${o.status} | bayar: ${o.payment?.status ?? "-"}` +
          ` | total: ${rupiah(Number(o.total))} | item: ${items}`
        );
      })
      .join("\n");

    return {
      key: "orders",
      label: `Pesanan terbaru seluruh marketplace (${orders.length} terbaru)`,
      scope: "admin",
      asOf,
      text,
    };
  }

  if (user.role === "SELLER") {
    const store = await prisma.store.findUnique({
      where: { userId: user.id },
      select: { id: true, storeName: true },
    });
    if (!store) return null;

    const items = await prisma.orderItem.findMany({
      where: { product: { storeId: store.id } },
      orderBy: { order: { createdAt: "desc" } },
      take: 8,
      include: {
        order: {
          select: {
            id: true,
            status: true,
            createdAt: true,
            total: true,
            buyer: { select: { name: true } },
          },
        },
        product: { select: { name: true } },
      },
    });
    if (items.length === 0) return null;

    const text = items
      .map(
        (i) =>
          `#${i.order.id.slice(0, 8)} | ${fmtDate(i.order.createdAt)} | status: ${i.order.status}` +
          ` | pembeli: ${i.order.buyer.name}` +
          ` | produk toko: ${i.product.name} x${i.quantity} | nilai pesanan: ${rupiah(Number(i.order.total))}`,
      )
      .join("\n");

    return {
      key: "orders",
      label: `Pesanan berisi produk toko "${store.storeName}" (${items.length} terbaru)`,
      scope: "toko-sendiri",
      asOf,
      text,
    };
  }

  return null;
}

/** Ringkasan penjualan toko — hanya SELLER pemilik toko. */
async function fetchSales(user: SafeUser): Promise<ContextSection | null> {
  if (user.role !== "SELLER") return null;

  const store = await prisma.store.findUnique({
    where: { userId: user.id },
    select: { id: true, storeName: true },
  });
  if (!store) return null;

  const agg = await prisma.orderItem.aggregate({
    where: {
      product: { storeId: store.id },
      order: { status: { not: "CANCELLED" } },
    },
    _sum: { quantity: true },
    _count: true,
  });

  const top = await prisma.orderItem.groupBy({
    by: ["productId"],
    where: {
      product: { storeId: store.id },
      order: { status: { not: "CANCELLED" } },
    },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: 5,
  });

  const topProducts =
    top.length > 0
      ? await prisma.product.findMany({
          where: { id: { in: top.map((t) => t.productId) } },
          select: { id: true, name: true },
        })
      : [];
  const nameById = new Map(topProducts.map((p) => [p.id, p.name]));

  // Pendapatan = Σ(price × quantity) — aggregate Prisma tidak bisa mengalikan,
  // jadi pakai SQL parameterized (Prisma.sql, aman dari injection).
  // Status transaksi mengikuti aturan bisnis aplikasi yang sama dengan
  // /api/seller/stats & /api/admin/stats (bukan total pesanan, bukan "batal").
  const revenueRows = await prisma.$queryRaw<{ total: string | number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(oi.price * oi.quantity), 0) AS total
    FROM "OrderItem" oi
    JOIN "Product" p ON p.id = oi."productId"
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE p."storeId" = ${store.id}
      AND o.status IN ('PROCESSING', 'SHIPPED', 'READY_FOR_PICKUP', 'COMPLETED')
  `);
  const revenue = Number(revenueRows[0]?.total ?? 0);

  const pendingAction = await prisma.orderItem.count({
    where: {
      product: { storeId: store.id },
      order: { status: { in: ["PENDING", "PROCESSING"] } },
    },
  });

  const qty = agg._sum.quantity ?? 0;
  const lines = [
    `Toko: ${store.storeName}`,
    `Produk terjual (unit, tanpa pesanan batal): ${qty} dari ${agg._count} baris pesanan`,
    `Pendapatan toko (pesanan Diproses/Dikirim/Siap Diambil/Selesai, seluruh periode): ${rupiah(revenue)}`,
    `Pesanan menunggu tindakan (PENDING/PROCESSING): ${pendingAction}`,
    top.length > 0
      ? `5 terlaris: ${top
          .map((t) => `${nameById.get(t.productId) ?? "(produk dihapus)"} x${t._sum.quantity ?? 0}`)
          .join(", ")}`
      : "Belum ada produk terjual.",
  ];

  return {
    key: "sales",
    label: "Ringkasan penjualan toko penjual yang sedang login",
    scope: "toko-sendiri",
    asOf: new Date().toISOString(),
    text: lines.join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* Pendapatan — aturan bisnis + batasan peran (intent REVENUE)         */
/* ------------------------------------------------------------------ */

/** Status transaksi yang dihitung sebagai pendapatan — definisi bisnis yang
 *  sama dengan /api/admin/stats dan /api/seller/stats (semua agregat). */
const REVENUE_STATUS_LIST = ["PROCESSING", "SHIPPED", "READY_FOR_PICKUP", "COMPLETED"];
const REVENUE_STATUS_TEXT = "Diproses, Dikirim, Siap Diambil, dan Selesai";
const REVENUE_PERIOD_TEXT = "seluruh periode data (sejak awal catatan transaksi)";

/** Periode laporan pendapatan dari bahasa alami → rentang waktu order. */
function parseRevenuePeriod(message: string): {
  start: Date | null;
  end: Date | null;
  text: string;
} {
  const m = message.toLowerCase();
  const now = new Date();
  const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (/\bkemarin\b/.test(m)) {
    const s = startOfDay(now);
    s.setDate(s.getDate() - 1);
    return { start: s, end: startOfDay(now), text: "kemarin" };
  }
  if (/\bhari ini\b/.test(m)) {
    const s = startOfDay(now);
    const e = startOfDay(now);
    e.setDate(e.getDate() + 1);
    return { start: s, end: e, text: "hari ini" };
  }
  if (/\bminggu ini\b/.test(m)) {
    const s = startOfDay(now);
    s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // minggu dihitung dari Senin
    const e = startOfDay(now);
    e.setDate(e.getDate() + 1);
    return { start: s, end: e, text: "minggu ini" };
  }
  if (/\bbulan lalu\b/.test(m)) {
    return {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(now.getFullYear(), now.getMonth(), 1),
      text: "bulan lalu",
    };
  }
  if (/\bbulan ini\b/.test(m)) {
    const e = startOfDay(now);
    e.setDate(e.getDate() + 1);
    return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: e, text: "bulan ini" };
  }
  if (/\btahun ini\b/.test(m)) {
    const e = startOfDay(now);
    e.setDate(e.getDate() + 1);
    return { start: new Date(now.getFullYear(), 0, 1), end: e, text: "tahun ini" };
  }
  return { start: null, end: null, text: REVENUE_PERIOD_TEXT };
}

/** "Produk apa yang menghasilkan pendapatan terbesar?" → ranking kontribusi. */
const TOP_REVENUE_PRODUCT_RE =
  /(?:\bproduk\b|\bbarang\b)[^.!?]{0,80}\b(?:terbesar|tertinggi|paling\s+banyak|paling\s+besar)\b|\bmenghasilkan\b[^.!?]{0,60}\b(?:terbesar|tertinggi|paling\s+besar)\b/;

/**
 * Total pendapatan sesuai peran — intent REVENUE:
 * - BUYER  → TIDAK PERNAH query (data internal) — jawab penolakan jujur.
 * - SELLER → hanya pendapatan toko miliknya sendiri (scope toko-sendiri).
 * - ADMIN  → pendapatan marketplace (definisi bisnis global).
 * Filter periode ("bulan ini", "kemarin", …) diterapkan di level database
 * pada order.createdAt; frasa "produk … pendapatan terbesar" → ranking
 * SUM(price × quantity) per produk. Kegagalan query → pesan jujur — BUKAN
 * angka 0/karangan dan BUKAN dialihkan ke rekomendasi produk.
 */
export async function fetchRevenue(user: SafeUser, message: string): Promise<ContextSection> {
  const asOf = new Date().toISOString();
  const limitation: ContextSection = {
    key: "revenue",
    label: "Keterbatasan data pendapatan (admin)",
    scope: "admin",
    asOf,
    text:
      "Pendapatan adalah data internal marketplace — hanya tersedia untuk admin " +
      "(pendapatan marketplace) dan penjual (pendapatan toko sendiri).",
  };

  // BUYER: jangan jalankan query sama sekali (tanpa kebocoran statistik internal).
  if (user.role === "BUYER") return limitation;

  const period = parseRevenuePeriod(message);
  const dateCond =
    period.start && period.end
      ? Prisma.sql` AND o."createdAt" >= ${period.start} AND o."createdAt" < ${period.end}`
      : Prisma.empty;
  const periodClause =
    period.start && period.end
      ? `pada periode ${period.text} (${fmtDate(period.start)} – ${fmtDate(period.end)})`
      : `pada periode ${REVENUE_PERIOD_TEXT}`;
  const periodSuffix = period.start ? ` (${period.text})` : "";
  const wantsTop = TOP_REVENUE_PRODUCT_RE.test(message.toLowerCase());

  try {
    let store: { id: string; storeName: string } | null = null;
    if (user.role === "SELLER") {
      store = await prisma.store.findUnique({
        where: { userId: user.id },
        select: { id: true, storeName: true },
      });
      if (!store) {
        return {
          ...limitation,
          label: "Keterbatasan data pendapatan (toko)",
          text: "Toko Anda belum terdaftar — data pendapatan toko tidak dapat diambil.",
        };
      }
    }
    const storeCond = store ? Prisma.sql` AND p."storeId" = ${store.id}` : Prisma.empty;

    const rows = await prisma.$queryRaw<{ total: string | number }[]>(Prisma.sql`
      SELECT COALESCE(SUM(oi.price * oi.quantity), 0) AS total
      FROM "OrderItem" oi
      JOIN "Product" p ON p.id = oi."productId"
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o.status IN (${Prisma.join(REVENUE_STATUS_LIST)})
      ${dateCond}
      ${storeCond}
    `);
    const total = Number(rows[0]?.total ?? 0);

    const lines = [
      user.role === "SELLER"
        ? `Total pendapatan toko Anda adalah ${rupiah(total)} berdasarkan pesanan dengan ` +
          `status yang memenuhi kriteria perhitungan (${REVENUE_STATUS_TEXT}), ${periodClause}.`
        : `Total pendapatan marketplace adalah ${rupiah(total)} berdasarkan pesanan dengan ` +
          `status yang memenuhi kriteria perhitungan (${REVENUE_STATUS_TEXT}), ${periodClause}.`,
    ];

    // Ranking kontribusi per produk ("pendapatan terbesar") — agregasi DB.
    if (wantsTop) {
      const top = await prisma.$queryRaw<
        { name: string; rev: string | number; units: string | number }[]
      >(Prisma.sql`
        SELECT p."name" AS name,
               SUM(oi.price * oi.quantity) AS rev,
               SUM(oi.quantity) AS units
        FROM "OrderItem" oi
        JOIN "Product" p ON p.id = oi."productId"
        JOIN "Order" o ON o.id = oi."orderId"
        WHERE o.status IN (${Prisma.join(REVENUE_STATUS_LIST)})
        ${dateCond}
        ${storeCond}
        GROUP BY p."id", p."name"
        ORDER BY rev DESC
        LIMIT 5
      `);
      lines.push("", "Produk dengan pendapatan terbesar:");
      if (top.length === 0) {
        lines.push("Belum ada produk terjual pada periode ini.");
      } else {
        top.forEach((r, i) =>
          lines.push(
            `${i + 1}. ${r.name} — ${rupiah(Number(r.rev))} (${Number(r.units)} unit terjual)`,
          ),
        );
      }
    }

    return {
      key: "revenue",
      label:
        user.role === "SELLER"
          ? `Total pendapatan toko${periodSuffix} (data aktual)`
          : `Total pendapatan marketplace${periodSuffix} (data aktual)`,
      scope: user.role === "SELLER" ? "toko-sendiri" : "admin",
      asOf,
      text: lines.join("\n"),
    };
  } catch (err) {
    // Kegagalan TIDAK PERNAH diubah menjadi angka 0 — tampilkan pesan jujur
    // khusus intent pendapatan (log aman: hanya nama tipe error).
    console.error("[ai-context] query pendapatan gagal:", err instanceof Error ? err.name : typeof err);
    return {
      key: "revenue",
      label: "Gangguan data pendapatan",
      scope: "admin",
      asOf,
      text: "Data pendapatan belum dapat diambil saat ini. Silakan coba lagi beberapa saat lagi.",
    };
  }
}

/** Statistik marketplace — hanya ADMIN. */
async function fetchStats(user: SafeUser): Promise<ContextSection | null> {
  if (user.role !== "ADMIN") return null;

  // Agregat global relatif stabil → cache 30 dtk (invalidasi route mutasi).
  const [users, products, orders, paidAgg, lowStock, storeRows, reviewAgg, paidPayments] =
    await cached("stats:admin", () =>
      Promise.all([
        prisma.user.groupBy({ by: ["role"], _count: true }),
        prisma.product.groupBy({ by: ["status"], _count: true }),
        prisma.order.groupBy({ by: ["status"], _count: true }),
        prisma.order.aggregate({
          where: { status: { in: ["PROCESSING", "SHIPPED", "READY_FOR_PICKUP", "COMPLETED"] } },
          _sum: { total: true },
        }),
        prisma.product.count({
          where: { stock: { lte: stockAlertThreshold() }, status: "AVAILABLE" },
        }),
        prisma.store.groupBy({ by: ["isActive"], _count: true }),
        prisma.review.aggregate({ _count: { _all: true }, _avg: { rating: true } }),
        prisma.payment.count({ where: { status: "PAID" } }),
      ]),
    );

  const fmt = (rows: { status?: string; role?: string; _count: number }[], label: string) =>
    rows.length === 0
      ? `${label}: 0`
      : `${label}: ` +
        rows
          .map(
            (r) =>
              `${(r as { status?: string; role?: string }).status ?? (r as { role?: string }).role}=${r._count}`,
          )
          .join(", ");

  const roleCount = (role: string): number =>
    users.find((u) => u.role === role)?._count ?? 0;

  const storeTotal = storeRows.reduce((a, s) => a + s._count, 0);
  const storeActive = storeRows.find((s) => s.isActive)?._count ?? 0;
  const reviewCount = reviewAgg._count._all ?? 0;
  const reviewAvg =
    reviewCount > 0 ? (Math.round((reviewAgg._avg.rating ?? 0) * 10) / 10).toFixed(1) : "-";

  const text = [
    `Jumlah pengguna total: ${users.reduce((a, u) => a + u._count, 0)}`,
    `Jumlah penjual (role SELLER): ${roleCount("SELLER")}`,
    `Jumlah pembeli (role BUYER): ${roleCount("BUYER")}`,
    `Jumlah admin (role ADMIN): ${roleCount("ADMIN")}`,
    `Toko terdaftar: ${storeTotal} (aktif: ${storeActive})`,
    fmt(products.map((p) => ({ status: p.status, _count: p._count })), "Produk per status"),
    fmt(orders.map((o) => ({ status: o.status, _count: o._count })), "Pesanan per status"),
    `Pendapatan (pesanan dibayar/dikirim/selesai): ${rupiah(Number(paidAgg._sum.total ?? 0))}`,
    `Pembayaran berhasil (status PAID): ${paidPayments}`,
    `Ulasan: ${reviewCount} — rating rata-rata: ${reviewAvg} dari 5`,
    `Produk stok menipis (≤ ${stockAlertThreshold()}): ${lowStock}`,
  ].join("\n");

  return {
    key: "stats",
    label: "Statistik marketplace (admin)",
    scope: "admin",
    asOf: new Date().toISOString(),
    text,
  };
}

/**
 * Jangkauan marketplace untuk NON-admin: jumlah toko aktif = data publik.
 * Jumlah pembeli/pengguna adalah data internal → hanya admin (fetchStats).
 */
async function fetchMarketReach(user: SafeUser, message: string): Promise<ContextSection> {
  const activeStores = await cached(
    `market-reach:${message.toLowerCase().replace(/\s+/g, " ").slice(0, 120)}`,
    () => prisma.store.count({ where: { isActive: true } }),
  );
  const asksBuyer = /pembeli|buyer/.test(message.toLowerCase());
  const asksFullStats =
    user.role !== "ADMIN" &&
    /\b(?:statistik|ringkasan|rekap|overview)\b/.test(message.toLowerCase());

  const lines = [
    `Toko aktif di marketplace: ${activeStores} (data publik)`,
    asksBuyer
      ? "Jumlah pembeli/pengguna adalah data internal platform — hanya tersedia untuk admin."
      : "",
    asksFullStats
      ? "Ringkasan statistik menyeluruh (jumlah pengguna seluruh role, pendapatan, dan pesanan marketplace) adalah data internal — hanya tersedia untuk admin."
      : "",
  ];

  return {
    key: "market",
    label: "Jangkauan marketplace (data publik)",
    scope: "publik",
    asOf: new Date().toISOString(),
    text: lines.filter(Boolean).join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* Hitungan per intent — PENGAMBILAN DATA dipisah dari FORMAT JAWABAN. */
/* ------------------------------------------------------------------ */

/** Label status pesanan (Indonesia) untuk jawaban hitungan pesanan. */
const ORDER_STATUS_LABEL = {
  PENDING: "Menunggu Pembayaran",
  PROCESSING: "Diproses",
  SHIPPED: "Dikirim",
  READY_FOR_PICKUP: "Siap Diambil",
  COMPLETED: "Selesai",
  CANCELLED: "Dibatalkan",
} as const;

type OrderStatusValue = keyof typeof ORDER_STATUS_LABEL;

/** Frasa Indonesia → status pesanan (undefined = semua status / tanpa filter). */
function parseOrderStatus(message: string): OrderStatusValue | undefined {
  const m = message.toLowerCase();
  if (/dibatalkan|\bbatal\b|cancel/.test(m)) return "CANCELLED";
  if (/\bselesai\b|completed/.test(m)) return "COMPLETED";
  if (/\bberhasil\b|\bsukses\b/.test(m)) return "COMPLETED"; // "pesanan berhasil" = selesai
  if (/siap diambil|ready.for.pickup/.test(m)) return "READY_FOR_PICKUP";
  if (/\bdikirim\b|shipped|pengiriman/.test(m)) return "SHIPPED";
  if (/diproses|processing/.test(m)) return "PROCESSING";
  if (/menunggu|pending|belum (?:dibayar|bayar)/.test(m)) return "PENDING";
  return undefined;
}

/**
 * Ambil SATU nilai hitungan aktual dari database sesuai intent & PERAN SESI.
 * Pemisahan data dari format: fungsi ini hanya mengembalikan angka.
 *
 * - angka = nilai nyata dari DB (0 sah bila memang kosong);
 * - null = peran tidak berwenang melihat (BUKAN nol — jangan samakan);
 * - melempar bila query gagal → route menjawab "layanan data tidak tersedia"
 *   (error TIDAK PERNAH diubah menjadi angka 0).
 *
 * Definisi entitas: "penjual" = akun role SELLER; "toko" = tabel Store;
 * "produk tersedia" = status AVAILABLE & stok > 0 (sama dengan katalog);
 * "habis" = non-hidden dan (OUT_OF_STOCK ATAU stok ≤ 0).
 */
export async function queryCountData(
  user: SafeUser,
  kind: CountKind,
  message: string,
): Promise<number | null> {
  switch (kind) {
    case "seller":
      return prisma.user.count({ where: { role: "SELLER" } });
    case "buyer":
      // Data internal platform — sama dengan model otorisasi fetchStats.
      return user.role === "ADMIN" ? prisma.user.count({ where: { role: "BUYER" } }) : null;
    case "admin":
      return user.role === "ADMIN" ? prisma.user.count({ where: { role: "ADMIN" } }) : null;
    case "user":
      return user.role === "ADMIN" ? prisma.user.count() : null;
    case "store":
      return prisma.store.count({
        where: /\baktif\b/.test(message.toLowerCase()) ? { isActive: true } : {},
      });
    case "totalProducts":
      return prisma.product.count({ where: { status: { not: "HIDDEN" } } });
    case "availableProducts":
      return prisma.product.count({ where: { status: "AVAILABLE", stock: { gt: 0 } } });
    case "outOfStockProducts":
      return prisma.product.count({
        where: {
          status: { not: "HIDDEN" },
          OR: [{ status: "OUT_OF_STOCK" }, { stock: { lte: 0 } }],
        },
      });
    case "orders": {
      const status = parseOrderStatus(message);
      if (user.role === "BUYER") {
        return prisma.order.count({ where: { buyerId: user.id, ...(status ? { status } : {}) } });
      }
      if (user.role === "SELLER") {
        const store = await prisma.store.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });
        // Belum punya toko → null (bukan nol karangan).
        if (!store) return null;
        return prisma.order.count({
          where: {
            orderItems: { some: { product: { storeId: store.id } } },
            ...(status ? { status } : {}),
          },
        });
      }
      return prisma.order.count({ where: { ...(status ? { status } : {}) } });
    }
    case "paidPayments":
      // Pembayaran berhasil (status PAID) — cakupan per peran, tabel Payment.
      if (user.role === "BUYER") {
        return prisma.payment.count({
          where: { status: "PAID", order: { buyerId: user.id } },
        });
      }
      if (user.role === "SELLER") {
        const store = await prisma.store.findUnique({
          where: { userId: user.id },
          select: { id: true },
        });
        if (!store) return null;
        return prisma.payment.count({
          where: {
            status: "PAID",
            order: { orderItems: { some: { product: { storeId: store.id } } } },
          },
        });
      }
      return prisma.payment.count({ where: { status: "PAID" } });
    case "reviews":
      // Ulasan bersifat publik pada halaman produk — berlaku untuk semua peran.
      return prisma.review.count();
    case "avgRating": {
      const agg = await prisma.review.aggregate({
        _avg: { rating: true },
        _count: { _all: true },
      });
      if ((agg._count._all ?? 0) === 0) return 0; // tanpa ulasan → 0 (bukan NaN)
      return Math.round((agg._avg.rating ?? 0) * 10) / 10;
    }
  }
}

/**
 * Format jawaban deterministik per intent — HANYA angka yang diminta,
 * tanpa menambahkan statistik lain (bukan ringkasan marketplace).
 */
export function formatCountAnswer(
  kind: CountKind,
  value: number | null,
  message: string,
  userRole: SafeUser["role"],
): string {
  const m = message.toLowerCase();
  if (value === null) {
    switch (kind) {
      case "buyer":
        return "Jumlah pembeli adalah data statistik internal platform — hanya tersedia untuk admin.";
      case "admin":
        return "Jumlah admin adalah data statistik internal platform — hanya tersedia untuk admin.";
      case "user":
        return "Jumlah pengguna adalah data statistik internal platform — hanya tersedia untuk admin.";
      case "orders":
        return "Toko Anda belum terdaftar — data pesanan toko tidak dapat diambil.";
      case "paidPayments":
        return "Toko Anda belum terdaftar — data pembayaran toko tidak dapat diambil.";
      default:
        return "Data ini tidak tersedia untuk Anda.";
    }
  }
  const n = value.toLocaleString("id-ID");
  switch (kind) {
    case "seller":
      return `Saat ini terdapat ${n} penjual terdaftar di Mendung Tirta.`;
    case "buyer":
      return `Saat ini terdapat ${n} pembeli terdaftar di Mendung Tirta.`;
    case "admin":
      return `Saat ini terdapat ${n} admin terdaftar di Mendung Tirta.`;
    case "user":
      return `Saat ini terdapat ${n} pengguna terdaftar di Mendung Tirta.`;
    case "store":
      return /\baktif\b/.test(m)
        ? `Saat ini terdapat ${n} toko aktif di Mendung Tirta.`
        : `Saat ini terdapat ${n} toko terdaftar di Mendung Tirta.`;
    case "totalProducts":
      return `Saat ini terdapat ${n} produk terdaftar di katalog Mendung Tirta.`;
    case "availableProducts":
      return value === 0
        ? "Belum ada produk yang tersedia untuk dibeli saat ini."
        : `Saat ini terdapat ${n} produk yang tersedia untuk dibeli.`;
    case "outOfStockProducts":
      return value === 0
        ? "Tidak ada produk dengan stok habis saat ini."
        : `Saat ini terdapat ${n} produk yang stoknya habis.`;
    case "orders": {
      const status = parseOrderStatus(message);
      const st = status ? ` berstatus ${ORDER_STATUS_LABEL[status]}` : "";
      if (value === 0) {
        if (userRole === "BUYER") return "Anda belum memiliki pesanan.";
        if (userRole === "SELLER") return `Toko Anda belum memiliki pesanan${st}.`;
        return `Belum ada pesanan di marketplace${st}.`;
      }
      if (userRole === "BUYER") return `Anda memiliki ${n} pesanan${st}.`;
      if (userRole === "SELLER") return `Toko Anda memiliki ${n} pesanan${st}.`;
      return `Terdapat ${n} pesanan di marketplace${st}.`;
    }
    case "paidPayments":
      if (value === 0) {
        if (userRole === "BUYER") return "Anda belum memiliki pembayaran yang berhasil.";
        if (userRole === "SELLER") return "Toko Anda belum memiliki pembayaran yang berhasil.";
        return "Belum ada pembayaran yang berhasil (berstatus PAID) di marketplace.";
      }
      if (userRole === "BUYER") return `Anda memiliki ${n} pembayaran yang berhasil.`;
      if (userRole === "SELLER") return `Toko Anda memiliki ${n} pembayaran yang berhasil.`;
      return `Terdapat ${n} pembayaran yang berhasil (berstatus PAID) di marketplace.`;
    case "reviews":
      return value === 0
        ? "Belum ada ulasan di Mendung Tirta saat ini."
        : `Saat ini terdapat ${n} ulasan di Mendung Tirta.`;
    case "avgRating":
      return value === 0
        ? "Belum ada ulasan — rating rata-rata belum dapat dihitung."
        : `Rating rata-rata seluruh ulasan adalah ${value} dari 5.`;
  }
}

/** Section konteks untuk satu pertanyaan hitungan (data + format terpisah). */
async function fetchCountSection(
  user: SafeUser,
  kind: CountKind,
  message: string,
): Promise<ContextSection> {
  // "Berapa jumlah pengguna setiap role?" → RINCIAN per role (admin) atau
  // penolakan peran yang jujur (non-admin) — bukan sekadar total pengguna.
  const perRoleRe =
    /\bsetiap\s+(?:role|jenis|peran)\b|\bper\s+(?:role|peran)\b|\btiap\s+(?:role|jenis|peran)\b|\bsemua\s+(?:role|peran)\b|\bper\s+jenis\b|\bmasing[- ]masing\s+(?:role|jenis|peran)\b/;
  if (kind === "user" && perRoleRe.test(message.toLowerCase())) {
    if (user.role !== "ADMIN") {
      return {
        key: "count",
        label: "Keterbatasan data pengguna per role (admin)",
        scope: "admin",
        asOf: new Date().toISOString(),
        text: "Jumlah pengguna per role adalah data statistik internal platform — hanya tersedia untuk admin.",
      };
    }
    const rows = await cached(`count:userrole:${user.id}`, () =>
      prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
    );
    const num = (n: number): string => n.toLocaleString("id-ID");
    const byRole = new Map(rows.map((r) => [r.role, r._count._all]));
    const total = rows.reduce((a, r) => a + r._count._all, 0);
    return {
      key: "count",
      label: "Jumlah pengguna setiap role (data aktual)",
      scope: "admin",
      asOf: new Date().toISOString(),
      text:
        `- Admin: ${num(byRole.get("ADMIN") ?? 0)}\n` +
        `- Penjual (Seller): ${num(byRole.get("SELLER") ?? 0)}\n` +
        `- Pembeli (Buyer): ${num(byRole.get("BUYER") ?? 0)}\n` +
        `Total: ${num(total)} pengguna terdaftar.`,
    };
  }

  // Hitungan relatif stabil + sudah discoping peran → cache 30 dtk per
  // (user, jenis, bentuk pertanyaan); invalidasi saat ada mutasi data.
  const value = await cached(
    `count:${user.id}:${kind}:${message.toLowerCase().replace(/\s+/g, " ").slice(0, 120)}`,
    () => queryCountData(user, kind, message),
  );
  const label: Record<CountKind, string> = {
    seller: "penjual",
    buyer: "pembeli",
    admin: "admin",
    user: "pengguna",
    store: "toko",
    totalProducts: "produk (total)",
    availableProducts: "produk tersedia",
    outOfStockProducts: "produk stok habis",
    orders: "pesanan",
    paidPayments: "pembayaran berhasil",
    reviews: "ulasan",
    avgRating: "rating rata-rata",
  };
  const publicKinds: CountKind[] = [
    "seller", "store", "totalProducts", "availableProducts", "outOfStockProducts",
    "reviews", "avgRating",
  ];
  const scope: ContextScope =
    value === null
      ? "admin"
      : kind === "orders" || kind === "paidPayments"
        ? user.role === "BUYER"
          ? "milik-sendiri"
          : user.role === "SELLER"
            ? "toko-sendiri"
            : "admin"
        : publicKinds.includes(kind)
          ? "publik"
          : "admin";

  return {
    key: "count",
    label:
      value === null
        ? `Keterbatasan data ${label[kind]} (admin)`
        : kind === "avgRating"
          ? "Rating rata-rata seluruh ulasan (data aktual)"
          : `Jumlah ${label[kind]} (data aktual)`,
    scope,
    asOf: new Date().toISOString(),
    text: formatCountAnswer(kind, value, message, user.role),
  };
}

/**
 * Hitungan produk DENGAN filter gabungan (subjek/harga/kategori) — dipakai
 * untuk pertanyaan seperti "berapa jumlah produk hasil laut?".
 * Query memakai kondisi AND yang sama dengan pencarian produk (parameterized);
 * error DB dilempar (bukan diubah jadi 0 atau hasil kosong).
 */
async function fetchFilteredCountSection(
  kind: CountKind,
  filters: ProductFilter,
): Promise<ContextSection> {
  const n = await cached(`fcount:${kind}:${JSON.stringify(filters)}`, () =>
    countCatalog(filters, {
      onlyAvailable: kind === "availableProducts",
      outOfStock: kind === "outOfStockProducts",
    }),
  );
  const subj = filters.subject
    ? ` ${filters.subject.phrase}`
    : filters.category
      ? ` kategori ${filters.category}`
      : "";
  const priceText = describePriceFilterText(filters.price);
  const text =
    n === 0
      ? `Tidak ada produk${subj} yang memenuhi kriteria tersebut saat ini.`
      : `Saat ini terdapat ${n} produk${subj}${priceText ? ` dengan harga ${priceText}` : ""} di katalog.`;

  return {
    key: "count",
    label: `Jumlah produk${subj.trim() ? ` "${subj.trim()}"` : ""} sesuai filter (data aktual)`,
    scope: "publik",
    asOf: new Date().toISOString(),
    text,
  };
}

/** Informasi aplikasi statis (layanan, tentang kami, panduan) — tanpa DB. */
async function fetchAppInfo(): Promise<ContextSection> {
  const text = [
    "Layanan Mendung Tirta: marketplace hasil laut segar (ikan, cumi-cumi, udang, dll.) dan alat pancing dari toko lokal terpercaya.",
    "Fitur yang tersedia: katalog produk, keranjang belanja, checkout & pembayaran, pelacakan pesanan, ulasan produk, notifikasi email & Telegram, dan asisten AI ini.",
    "Tentang Kami: Mendung Tirta lahir dari kota pinggir laut, menghubungkan nelayan dan penjual perlengkapan memancing lokal langsung dengan pembeli — tanpa perantara berlebihan; hasil panen segar pagi hari sampai ke meja Anda.",
    "Panduan singkat: (1) Daftar atau masuk akun, (2) telusuri katalog, (3) tambahkan produk ke keranjang, (4) selesaikan checkout dan pembayaran, (5) pantau status pesanan di Dashboard, (6) ubah nama/alamat/password di menu akun → Informasi Diri.",
  ].join("\n");

  return {
    key: "appinfo",
    label: "Informasi layanan & panduan Mendung Tirta",
    scope: "publik",
    asOf: new Date().toISOString(),
    text,
  };
}

/* ------------------------------------------------------------------ */
/* Role pengguna: jenis, hak akses, daftar (BUKAN profil akun sendiri) */
/* ------------------------------------------------------------------ */

/**
 * Definisi role & hak akses — diselaraskan dengan fitur yang BENAR-BENAR
 * ada di repository (route API + halaman per peran):
 * - admin  : /admin/{users,products,categories,stores,orders,reviews,stats,integrations}
 * - seller : /seller/{products,orders,profile,dashboard} + /api/seller/*
 * - buyer  : /products, /cart, /checkout, /orders, /profile + ulasan produk
 */
const ROLE_DEFINITIONS: {
  role: "ADMIN" | "SELLER" | "BUYER";
  title: string;
  duties: string[];
}[] = [
  {
    role: "ADMIN",
    title: "ADMIN (Administrator)",
    duties: [
      "Mengelola pengguna: melihat daftar, mengubah peran, dan mengaktifkan/menonaktifkan akun (/admin/users)",
      "Mengelola produk, kategori, dan toko marketplace (/admin/products, /admin/categories, /admin/stores)",
      "Memantau pesanan dan transaksi seluruh marketplace (/admin/orders)",
      "Memantau serta menangani ulasan produk (/admin/reviews)",
      "Mengelola operasional & integrasi platform, mis. WhatsApp dan Telegram (/admin/integrations)",
      "Melihat statistik dan laporan marketplace (/admin/dashboard)",
    ],
  },
  {
    role: "SELLER",
    title: "SELLER (Penjual)",
    duties: [
      "Mengelola profil toko sendiri (/seller/profile)",
      "Menambahkan, mengubah, dan menghapus produk toko — termasuk harga, stok, dan status (/seller/products)",
      "Memproses pesanan yang berisi produk toko: konfirmasi, pengiriman, atau pembatalan",
      "Melihat riwayat pesanan toko (/seller/orders)",
      "Melihat pendapatan dan laporan penjualan toko sendiri (/seller/dashboard)",
    ],
  },
  {
    role: "BUYER",
    title: "BUYER (Pembeli)",
    duties: [
      "Melihat dan mencari produk di katalog (/products)",
      "Mengelola keranjang belanja, menyelesaikan checkout, dan membayar pesanan (/cart, /checkout)",
      "Melihat riwayat serta status pesanan sendiri (/orders)",
      "Memberikan ulasan dan rating untuk produk yang dibeli",
      "Mengelola informasi diri: nama, alamat, dan password (/profile)",
    ],
  },
];

/**
 * Section role — sumber jawaban untuk USER_ROLES / ROLE_PERMISSION /
 * USER_LIST. Terpisah tegas dari profil akun ("Informasi akun Anda"):
 * pertanyaan "Ada apa saja role pengguna?" TIDAK PERNAH dijawab dengan
 * nama/email/alamat user yang sedang login.
 * USER_LIST menargetkan role yang ditanya (penjual/toko = info publik untuk
 * semua peran; pembeli/pengguna = internal, hanya admin) — lihat
 * fetchUserListSection.
 *
 * USER_ROLES juga menyertakan JUMLAH akun per role — COUNT real-time dari
 * database (groupBy role, konsisten dengan /api/admin/stats yang dipakai
 * dashboard admin). Total = penjumlahan ketiga role; hanya angka (tanpa
 * email/PII); bila query gagal → pesan jujur "statistik belum tersedia"
 * (bukan 0, bukan angka karangan). Berlaku untuk semua peran login.
 */
export async function fetchRolesSection(
  user: SafeUser,
  intent: ChatbotIntent,
  message: string,
): Promise<ContextSection> {
  const asOf = new Date().toISOString();

  // USER_LIST — daftar pengguna menurut PERTANYAAN (target role + hak akses):
  // penjual/toko = info publik semua peran; pembeli/pengguna/admin = internal
  // (hanya admin). Rincian di fetchUserListSection.
  if (intent === "USER_LIST") return fetchUserListSection(user, message, asOf);

  // USER_ROLES (semua role) / ROLE_PERMISSION (satu role bila disebut).
  const m = message.toLowerCase();
  const targeted =
    intent === "ROLE_PERMISSION"
      ? ROLE_DEFINITIONS.filter((d) =>
          d.role === "ADMIN"
            ? /\badmin(?:istrator)?\b/.test(m)
            : d.role === "SELLER"
              ? /\bpenjual\b|\bseller\b/.test(m)
              : /\bpembeli\b|\bbuyer\b/.test(m),
        )
      : [];
  const defs = targeted.length > 0 ? targeted : ROLE_DEFINITIONS;
  const intro =
    intent === "ROLE_PERMISSION"
      ? targeted.length === 1
        ? `Hak akses ${targeted[0].title} di Mendung Tirta:`
        : "Hak akses tiap role di Mendung Tirta:"
      : "Role pengguna di Mendung Tirta ada 3: ADMIN, SELLER (Penjual), BUYER (Pembeli).";
  const body = defs
    .map((d) => `${d.title}:\n${d.duties.map((x) => `- ${x}`).join("\n")}`)
    .join("\n\n");

  // USER_ROLES → jumlah akun per role: COUNT real-time dari DB (tanpa cache)
  // agar selalu konsisten dengan dashboard admin; total dihitung sebagai
  // penjumlahan ketiga role. Gagal query → pesan jujur, TANPA angka karangan.
  let stats = "";
  if (intent === "USER_ROLES") {
    try {
      const rows = await prisma.user.groupBy({ by: ["role"], _count: { _all: true } });
      const byRole = new Map(rows.map((r) => [r.role, r._count._all] as const));
      const nAdmin = byRole.get("ADMIN") ?? 0;
      const nSeller = byRole.get("SELLER") ?? 0;
      const nBuyer = byRole.get("BUYER") ?? 0;
      stats =
        "Jumlah pengguna per role:\n" +
        `1. ADMIN: ${nAdmin}\n` +
        `2. SELLER (Penjual): ${nSeller}\n` +
        `3. BUYER (Pembeli): ${nBuyer}\n` +
        `4. Total pengguna: ${nAdmin + nSeller + nBuyer}`;
    } catch {
      stats =
        "Statistik jumlah pengguna per role belum tersedia saat ini — database tidak " +
        "dapat diakses. Silakan coba lagi nanti.";
    }
  }

  return {
    key: "roles",
    label:
      intent === "ROLE_PERMISSION"
        ? "Hak akses role (definisi aplikasi)"
        : "Role pengguna & hak akses (definisi aplikasi)",
    scope: "publik",
    asOf,
    text: stats ? `${intro}\n\n${stats}\n\n${body}` : `${intro}\n\n${body}`,
  };
}

/* ------------------------------------------------------------------ */
/* USER_LIST — daftar pengguna MENURUT ROLE + hak akses                 */
/* ------------------------------------------------------------------ */

/** Urutan tampilan role pada daftar gabungan pengguna. */
const USER_LIST_ROLES = ["ADMIN", "SELLER", "BUYER"] as const;
type UserListRole = (typeof USER_LIST_ROLES)[number];

/** Noun label per target daftar (SELLER/STORE terpisah di fetchSellerListSection). */
const USER_LIST_NOUN: Record<"ADMIN" | "BUYER" | "ALL", string> = {
  ADMIN: "admin",
  BUYER: "pembeli",
  ALL: "pengguna",
};

/** Baris daftar pengguna (hasil select — tanpa email/PII/kredensial). */
type UserListRow = {
  name: string;
  isActive: boolean;
  store: { storeName: string; isActive: boolean } | null;
};

/**
 * Filter status akun yang diminta EKSPISIT pada pesan: "…yang aktif?" →
 * hanya akun aktif; "…belum aktif?"/"…nonaktif?" → hanya akun nonaktif.
 * Tanpa kata status → tidak ada filter (tampil semua status, jujur).
 */
function detectAccountStatusFilter(m: string): boolean | undefined {
  if (/\bbelum\s+aktif\b|\bnonaktif\b/.test(m)) return false;
  if (/\baktif\b/.test(m)) return true;
  return undefined;
}

/**
 * USER_LIST — daftar pengguna sesuai target pertanyaan (detectUserListTarget):
 * - SELLER/STORE → daftar penjual + toko: INFO PUBLIK untuk semua peran;
 *   non-admin hanya akun & toko AKTIF, admin data lengkap (termasuk
 *   nonaktif). Isi: nama penjual, nama toko, status akun, status toko,
 *   jumlah produk, jumlah produk tersedia — TANPA email/telefon/alamat.
 * - BUYER/ADMIN/ALL → data internal platform: HANYA admin. Baris memuat
 *   IDENTITAS NYATA dari database (nama, status akun, toko untuk penjual),
 *   dikelompokkan ADMIN → SELLER → BUYER dengan JUMLAH per role, plus
 *   total; filter status eksplisit ("yang aktif"/"belum aktif");
 *   pagination "halaman N" (10 baris/halaman) dengan penanda halaman —
 *   tidak pernah memotong daftar tanpa memberi tahu.
 *
 * Query gagal → error mengendap ke route (jawaban "gangguan sistem"),
 * tidak pernah diubah jadi "data tidak ditemukan" atau angka karangan.
 */
async function fetchUserListSection(
  user: SafeUser,
  message: string,
  asOf: string,
): Promise<ContextSection> {
  const target = detectUserListTarget(message) ?? "ALL";

  // Penjual/toko = informasi publik (semua peran); lainnya = internal.
  if (target === "SELLER" || target === "STORE") {
    return fetchSellerListSection(user, message, target, asOf);
  }

  const noun = USER_LIST_NOUN[target];
  if (user.role !== "ADMIN") {
    return {
      key: "userlist",
      label: `Keterbatasan data ${noun} (admin)`,
      scope: "admin",
      asOf,
      text: `Daftar ${noun} adalah data internal platform — hanya dapat dilihat oleh admin.`,
    };
  }

  const m = message.toLowerCase();
  const statusFilter = detectAccountStatusFilter(m);
  const where: Prisma.UserWhereInput = {};
  if (target === "BUYER") where.role = "BUYER";
  else if (target === "ADMIN") where.role = "ADMIN";
  if (statusFilter !== undefined) where.isActive = statusFilter;

  // Pagination "halaman N"/"halaman ke-N" (default halaman 1) — 10 baris
  // per halaman agar muat dalam batas panjang jawaban tanpa terpotong.
  const PAGE_SIZE = 10;
  const pageMatch = /\bhalaman\s+(?:ke-)?(\d+)\b/.exec(m);
  const page = Math.max(1, Number.parseInt(pageMatch?.[1] ?? "1", 10) || 1);
  const skip = (page - 1) * PAGE_SIZE;

  // Jumlah AKTUAL per role (groupBy real-time) → total, ringkasan per role,
  // dan paginasi — daftar tidak pernah mengandalkan jumlah baris halaman.
  const grouped = await prisma.user.groupBy({
    by: ["role"],
    where,
    _count: { _all: true },
  });
  const byRole = new Map(grouped.map((r) => [r.role, r._count._all] as const));
  const roles: readonly UserListRole[] = target === "ALL" ? USER_LIST_ROLES : [target];
  const countOf = (r: UserListRole): number => byRole.get(r) ?? 0;
  const total = roles.reduce((sum, r) => sum + countOf(r), 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const statusSuffix =
    statusFilter === undefined ? "" : statusFilter ? " aktif" : " belum aktif";
  const label =
    total === 0 ? `Daftar ${noun}` : `Daftar ${noun}${statusSuffix} (${total} akun)`;
  const scope: ContextScope = "admin";

  // Data kosong → jujur ("belum ada"), bukan angka 0, bukan karangan.
  if (total === 0) {
    return {
      key: "userlist",
      label,
      scope,
      asOf,
      text:
        statusFilter === undefined
          ? `Belum ada ${noun} terdaftar di Mendung Tirta.`
          : `Belum ada ${noun} dengan status ${statusFilter ? "aktif" : "belum aktif"} terdaftar di Mendung Tirta.`,
    };
  }

  // Halaman di luar jangkauan → sampaikan jujur, jangan mengarang isi.
  if (skip >= total) {
    return {
      key: "userlist",
      label,
      scope,
      asOf,
      text:
        `Halaman ${page} tidak tersedia — daftar ${noun} hanya memiliki ` +
        `${totalPages} halaman (${total} akun). Tanyakan "halaman 1" untuk melihat dari awal.`,
    };
  }

  // Baris halaman ini: role berurutan (ADMIN → SELLER → BUYER), nama A–Z;
  // tiap role di-query dengan skip/take sendiri agar penomoran tetap GLOBAL
  // per role walau halaman memotong di tengah kelompok.
  const flatEnd = skip + PAGE_SIZE;
  const groups: { role: UserListRole; rows: UserListRow[]; start: number }[] = [];
  let offset = 0;
  for (const role of roles) {
    const roleStart = offset;
    offset += countOf(role);
    const from = Math.max(skip, roleStart);
    const to = Math.min(flatEnd, roleStart + countOf(role));
    if (from >= to) continue;
    const rows = await prisma.user.findMany({
      where: { ...where, role },
      orderBy: { name: "asc" },
      skip: from - roleStart,
      take: to - from,
      select: {
        name: true,
        isActive: true,
        store: { select: { storeName: true, isActive: true } },
      },
    });
    groups.push({ role, rows, start: from - roleStart });
  }

  const roleWord: Record<UserListRole, string> = {
    ADMIN: "admin",
    SELLER: "penjual",
    BUYER: "pembeli",
  };
  const roleTitle: Record<UserListRole, string> = {
    ADMIN: "ADMIN",
    SELLER: "SELLER",
    BUYER: "BUYER",
  };
  const lines: string[] = [];
  if (target === "ALL") {
    // Ringkasan jumlah per role — angka AKTUAL penuh (bukan isi halaman).
    lines.push(
      `Total pengguna: ${total} — ADMIN: ${countOf("ADMIN")}, ` +
        `SELLER (Penjual): ${countOf("SELLER")}, BUYER (Pembeli): ${countOf("BUYER")}.`,
    );
  }
  let shown = 0;
  for (const g of groups) {
    if (target === "ALL") lines.push(`${roleTitle[g.role]} (${countOf(g.role)}):`);
    g.rows.forEach((u, i) => {
      const idx = g.start + i + 1;
      const toko =
        g.role === "SELLER"
          ? u.store
            ? ` — Toko: ${u.store.storeName} (${u.store.isActive ? "Aktif" : "Nonaktif"})`
            : " — Toko: -"
          : "";
      lines.push(
        `${idx}. Nama ${roleWord[g.role]}: ${u.name}${toko} — Status: ${u.isActive ? "Aktif" : "Nonaktif"}`,
      );
      shown++;
    });
  }
  if (target !== "ALL") lines.push(`Total ${noun}: ${total}.`);
  if (totalPages > 1) {
    lines.push(
      `Halaman ${page} dari ${totalPages} — menampilkan pengguna ke-${skip + 1}–${skip + shown} dari ${total}. ` +
        (page < totalPages
          ? `Tanyakan "halaman ${page + 1}" untuk halaman berikutnya.`
          : `Tanyakan "halaman 1" untuk kembali ke halaman awal.`),
    );
  }

  return { key: "userlist", label, scope, asOf, text: lines.join("\n") };
}

/**
 * Daftar penjual/toko (USER_LIST target SELLER/STORE) — data aktual dari
 * database, bukan data statis:
 * - ADMIN → seluruh penjual (termasuk akun/toko nonaktif, status ditampilkan);
 * - non-admin → hanya penjual ber-akun-AKTIF dengan toko aktif (atau tanpa
 *   toko) — "informasi publik penjual dan toko yang aktif";
 * - "produk tersedia" = status AVAILABLE & stok > 0 (definisi sama dengan
 *   katalog & hitungan) → hanya penjual yang memilikinya.
 */
async function fetchSellerListSection(
  user: SafeUser,
  message: string,
  target: "SELLER" | "STORE",
  asOf: string,
): Promise<ContextSection> {
  const full = user.role === "ADMIN";
  const onlyAvailable = /\b(?:produk|barang)\s+(?:yang\s+)?tersedia\b/.test(message.toLowerCase());
  const storeFocus = target === "STORE"; // "tampilkan semua nama toko"

  const where: Prisma.UserWhereInput = { role: "SELLER" };
  if (!full) where.isActive = true;
  if (onlyAvailable) {
    where.store = {
      ...(full && !storeFocus ? {} : { isActive: true }),
      products: { some: { status: "AVAILABLE", stock: { gt: 0 } } },
    };
  } else if (storeFocus) {
    // Daftar TOKO → wajib punya toko (penjual tanpa toko tak punya nama toko).
    where.store = full ? { isNot: null } : { isActive: true };
  } else if (!full) {
    where.OR = [{ store: null }, { store: { isActive: true } }];
  }

  const rows = await prisma.user.findMany({
    where,
    orderBy: { name: "asc" },
    take: 21, // 20 tampil + penanda "masih ada" (pagination)
    select: {
      name: true,
      isActive: true,
      store: {
        select: {
          id: true,
          storeName: true,
          isActive: true,
          _count: { select: { products: true } },
        },
      },
    },
  });

  const more = rows.length > 20;
  const shown = more ? rows.slice(0, 20) : rows;
  const noun = storeFocus ? "toko" : "penjual";
  const scope: ContextScope = full ? "admin" : "publik";

  if (shown.length === 0) {
    return {
      key: "userlist",
      label: `Daftar ${noun}`,
      scope,
      asOf,
      text: onlyAvailable
        ? "Belum ada penjual dengan produk tersedia saat ini."
        : storeFocus
          ? "Belum ada toko terdaftar di Mendung Tirta."
          : "Belum ada penjual terdaftar di Mendung Tirta.",
    };
  }

  // Jumlah produk tersedia per toko — SATU query groupBy untuk seluruh halaman.
  const storeIds = shown.flatMap((r) => (r.store ? [r.store.id] : []));
  const availRows =
    storeIds.length > 0
      ? await prisma.product.groupBy({
          by: ["storeId"],
          where: { storeId: { in: storeIds }, status: "AVAILABLE", stock: { gt: 0 } },
          _count: { _all: true },
        })
      : [];
  const availByStore = new Map(availRows.map((r) => [r.storeId, r._count._all]));

  const lines = shown.map((u, i) => {
    const akun = `Akun: ${u.isActive ? "Aktif" : "Nonaktif"}`;
    const st = u.store;
    if (storeFocus && st) {
      const produk = `Produk: ${st._count.products} (${availByStore.get(st.id) ?? 0} tersedia)`;
      return (
        `${i + 1}. ${st.storeName} — Pemilik: ${u.name} — ` +
        `Toko: ${st.isActive ? "Aktif" : "Nonaktif"} — ${akun} — ${produk}`
      );
    }
    const toko = st ? `Toko: ${st.storeName} (${st.isActive ? "Aktif" : "Nonaktif"})` : "Toko: -";
    const produk = st
      ? `Produk: ${st._count.products} (${availByStore.get(st.id) ?? 0} tersedia)`
      : "Produk: -";
    return `${i + 1}. ${u.name} — ${akun} — ${toko} — ${produk}`;
  });

  // Total AKTUAL (bukan hanya isi halaman) — saat daftar terpotong, hitung
  // penuh lewat count() supaya "Total penjual: N" tidak pernah diremehkan.
  const total = more ? await prisma.user.count({ where }) : shown.length;
  const label = `Daftar ${noun}${onlyAvailable ? " dengan produk tersedia" : ""} (${total})`;
  const text =
    lines.join("\n") +
    `\nTotal ${noun}: ${total}.` +
    (more ? "\n…masih ada data lain yang tidak ditampilkan (batas 20 baris per jawaban)." : "");
  return { key: "userlist", label, scope, asOf, text };
}

/**
 * Ulasan produk — publik, tapi dibatasi jumlah baris.
 * Ambil ulasan untuk produk spesifik (jika ada fokus) atau ulasan terbaru.
 */
async function fetchReviews(
  productIds: string[] | undefined,
): Promise<ContextSection | null> {
  // Jika ada fokus produk → ambil ulasan produk itu; jika tidak → ulasan terbaru
  const where = productIds && productIds.length > 0
    ? { productId: { in: productIds } }
    : {};

  const reviews = await prisma.review.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 8,
    include: {
      buyer: { select: { name: true } },
      product: { select: { name: true } },
    },
  });

  if (reviews.length === 0) return null;

  const text = reviews
    .map(
      (r) =>
        `${r.product.name} — ${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)} (${r.rating}/5) — ` +
        `${r.buyer.name}: ${r.comment?.slice(0, 120) || "(tanpa komentar)"} — ${fmtDate(r.createdAt)}`,
    )
    .join("\n");

  return {
    key: "reviews",
    label: productIds && productIds.length > 0
      ? `Ulasan produk (${reviews.length} terbaru)`
      : `Ulasan produk terbaru (${reviews.length})`,
    scope: "publik",
    asOf: new Date().toISOString(),
    text,
  };
}

/** Produk stok menipis — info katalog publik (stok terlihat di halaman produk). */
async function fetchLowStock(user: SafeUser, message: string): Promise<ContextSection | null> {
  const threshold = stockAlertThreshold();
  const wantsOwn = user.role === "SELLER" && /\b(saya|toko saya|produk saya|sendiri)\b/.test(message.toLowerCase());

  let storeId: string | undefined;
  if (wantsOwn) {
    const store = await prisma.store.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    storeId = store?.id;
    if (!storeId) return null;
  }

  const products = await prisma.product.findMany({
    where: {
      stock: { lte: threshold },
      status: { not: "HIDDEN" },
      ...(storeId ? { storeId } : {}),
    },
    orderBy: { stock: "asc" },
    take: 8,
    select: {
      id: true,
      name: true,
      stock: true,
      price: true,
      status: true,
      store: { select: { storeName: true } },
    },
  });
  if (products.length === 0) return null;

  const text = products
    .map(
      (p) =>
        `${p.name} — stok ${p.stock} (status ${p.status}) — ${rupiah(Number(p.price))} — ${p.store.storeName}`,
    )
    .join("\n");

  return {
    key: "lowstock",
    label: `Produk dengan stok ≤ ${threshold}${wantsOwn ? " (toko sendiri)" : " (katalog publik)"}`,
    scope: wantsOwn ? "toko-sendiri" : "publik",
    asOf: new Date().toISOString(),
    text,
  };
}

/** Produk stok habis — agar AI bisa menjawab "produk apa yang habis" dengan data. */
async function fetchOutOfStock(user: SafeUser, message: string): Promise<ContextSection> {
  const wantsOwn = user.role === "SELLER" && /\b(saya|toko saya|produk saya|sendiri)\b/.test(message.toLowerCase());

  let storeId: string | undefined;
  if (wantsOwn) {
    const store = await prisma.store.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    storeId = store?.id;
  }

  // Definisi "habis" konsisten dengan katalog: status OUT_OF_STOCK ATAU stok ≤ 0
  // ( produk AVAILABLE dengan stok 0 juga dianggap tidak tersedia ).
  const products = await prisma.product.findMany({
    where: {
      status: { not: "HIDDEN" },
      OR: [{ status: "OUT_OF_STOCK" }, { stock: { lte: 0 } }],
      ...(storeId ? { storeId } : {}),
    },
    orderBy: { name: "asc" },
    take: 8,
    select: {
      name: true,
      stock: true,
      price: true,
      status: true,
      store: { select: { storeName: true } },
    },
  });

  // Section tetap dikembalikan meski kosong — agar AI dapat menyatakan
  // "tidak ada produk habis" berdasar data, bukan mengarang.
  const text =
    products.length === 0
      ? "Tidak ada produk dengan stok habis saat ini."
      : products
          .map(
            (p) =>
              `${p.name} — stok ${p.stock} (status ${p.status}) — ${rupiah(Number(p.price))} — ${p.store.storeName}`,
          )
          .join("\n");

  return {
    key: "outofstock",
    label: `Produk dengan stok habis${wantsOwn ? " (toko sendiri)" : " (katalog publik)"}`,
    scope: wantsOwn ? "toko-sendiri" : "publik",
    asOf: new Date().toISOString(),
    text,
  };
}

/**
 * Ringkasan katalog — SELALU dijalankan agar AI bisa membedakan kondisi:
 * katalog benar-benar kosong vs produk ada tetapi habis vs belum ada produk
 * aktif. Definisi "tersedia" sama persis dengan pencarian katalog.
 */
async function fetchCatalogSummary(): Promise<ContextSection> {
  const [total, available, unavailable, hidden] = await cached("catalog-summary", () =>
    Promise.all([
      prisma.product.count({ where: { status: { not: "HIDDEN" } } }),
      prisma.product.count({ where: { status: "AVAILABLE", stock: { gt: 0 } } }),
      prisma.product.count({
        where: {
          status: { not: "HIDDEN" },
          OR: [{ status: "OUT_OF_STOCK" }, { stock: { lte: 0 } }],
        },
      }),
      prisma.product.count({ where: { status: "HIDDEN" } }),
    ]),
  );

  const lines = [
    `Total produk non-hidden: ${total}`,
    `Tersedia untuk dibeli (status AVAILABLE & stok > 0): ${available}`,
    `Stok habis / tidak tersedia: ${unavailable}`,
    `Produk tersembunyi (HIDDEN): ${hidden}`,
  ];

  return {
    key: "catalog",
    label: "Ringkasan katalog (hitungan produk per ketersediaan)",
    scope: "publik",
    asOf: new Date().toISOString(),
    text: lines.join("\n"),
  };
}

/** Profil toko yang relevan — info publik marketplace. */
/**
 * Profil toko publik. `anyIfEmpty` → tanpa kata kunci pun tetap menampilkan
 * toko aktif teratas (dipakai intent STORE_INFO seperti "Siapa penjualnya?").
 */
async function fetchStores(
  keywords: string[],
  opts?: { anyIfEmpty?: boolean },
): Promise<ContextSection | null> {
  if (keywords.length === 0 && !opts?.anyIfEmpty) return null;

  // Pencarian kata per kata (Prisma String filter tidak punya hasSome —
  // gunakan contains case-insensitive, sama dengan pola /api/admin/users).
  const orClauses = keywords.flatMap((kw) => [
    { storeName: { contains: kw, mode: "insensitive" as const } },
    { description: { contains: kw, mode: "insensitive" as const } },
    { location: { contains: kw, mode: "insensitive" as const } },
  ]);

  const stores = await cached(
    `stores:${keywords.length > 0 ? JSON.stringify(keywords) : "any"}`,
    () =>
      prisma.store.findMany({
        where:
          keywords.length > 0
            ? { isActive: true, OR: orClauses }
            : { isActive: true },
        take: 5,
        select: {
          storeName: true,
          location: true,
          description: true,
          _count: { select: { products: true } },
        },
      }),
  );
  if (stores.length === 0) return null;

  const text = stores
    .map(
      (s) =>
        `${s.storeName} — lokasi: ${s.location ?? "-"} — ${s._count.products} produk` +
        `${s.description ? ` — ${s.description.slice(0, 120)}` : ""}`,
    )
    .join("\n");

  return {
    key: "store",
    label: "Profil toko (data publik)",
    scope: "publik",
    asOf: new Date().toISOString(),
    text,
  };
}

/**
 * "Siapa penjual ikan kerapu?" → penjual/toko PEMILIK produk yang cocok
 * dengan frasa subjek (nama produk setelah pembuang "siapa penjual…").
 * Tanpa frasa subjek atau tanpa produk cocok → null (lanjut fetchStores).
 * Data publik saja: nama penjual, nama & status toko/akun, jumlah produk —
 * TANPA email/telefon/alamat (PII).
 */
async function fetchSellerOfProduct(message: string): Promise<ContextSection | null> {
  const m = message.toLowerCase();
  if (!/\bsiapa\b/.test(m)) return null; // hanya pertanyaan "siapa penjual…"
  const phrase = extractSubjectPhrase(
    m.replace(/\bsiapa\s+(?:yang\s+)?(?:penjual|seller|toko|pemilik\s+toko)\b/g, " "),
  );
  if (!phrase) return null;

  const rows = await prisma.product.findMany({
    where: { name: { contains: phrase, mode: "insensitive" }, status: { not: "HIDDEN" } },
    select: {
      name: true,
      store: {
        select: {
          id: true,
          storeName: true,
          isActive: true,
          user: { select: { name: true, isActive: true } },
          _count: { select: { products: true } },
        },
      },
    },
    take: 20,
  });
  if (rows.length === 0) return null;

  // Kelompokkan produk per toko → penjual unik (1 penjual biasanya cukup).
  const byStore = new Map<string, { store: (typeof rows)[0]["store"]; products: string[] }>();
  for (const r of rows) {
    const e = byStore.get(r.store.id);
    if (e) e.products.push(r.name);
    else byStore.set(r.store.id, { store: r.store, products: [r.name] });
  }
  const availRows = await prisma.product.groupBy({
    by: ["storeId"],
    where: { storeId: { in: [...byStore.keys()] }, status: "AVAILABLE", stock: { gt: 0 } },
    _count: { _all: true },
  });
  const availByStore = new Map(availRows.map((r) => [r.storeId, r._count._all]));

  const lines = [...byStore.values()].map(({ store: st, products }, i) => {
    const matched =
      products.slice(0, 3).join(", ") + (products.length > 3 ? `, +${products.length - 3} lain` : "");
    return (
      `${i + 1}. ${st.user.name} — Toko: ${st.storeName} (${st.isActive ? "Aktif" : "Nonaktif"}) — ` +
      `Akun: ${st.user.isActive ? "Aktif" : "Nonaktif"} — ` +
      `Produk toko: ${st._count.products} (${availByStore.get(st.id) ?? 0} tersedia)\n` +
      `   Produk cocok: ${matched}`
    );
  });
  return {
    key: "store",
    label: `Penjual produk "${phrase}"`,
    scope: "publik",
    asOf: new Date().toISOString(),
    text: lines.join("\n"),
  };
}

/**
 * "Siapa pemilik toko Pancing Jaya?" → PEMILIK toko: nama publik + status
 * toko/akun + jumlah produk — TANPA email/telefon (PII). Tanpa nama toko →
 * klarifikasi singkat; nama tak ditemukan → penolakan jujur (section tetap
 * dikembalikan agar bukan jawaban "data tidak ditemukan" generik).
 */
export async function fetchStoreOwner(message: string): Promise<ContextSection | null> {
  const m = message.toLowerCase();
  if (!/\bsiapa\b/.test(m)) return null; // hanya pertanyaan "siapa pemilik…"
  if (!/\bpemilik\b|\bpunya\b|\bowner\b/.test(m)) return null;

  const subject = m
    .replace(/^[\s\S]*?\b(?:pemilik(?:nya)?|punya|owner(?:nya)?)\b\s*(?:toko|store)?\s*/, "")
    .replace(/[?!,."']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const asOf = new Date().toISOString();
  if (!subject) {
    return {
      key: "store",
      label: "Klarifikasi pemilik toko",
      scope: "publik",
      asOf,
      text: 'Toko mana yang dimaksud? Sebutkan nama tokonya (mis. "Siapa pemilik toko Pancing Jaya?").',
    };
  }

  const store = await prisma.store.findFirst({
    where: { storeName: { contains: subject, mode: "insensitive" } },
    select: {
      id: true,
      storeName: true,
      location: true,
      isActive: true,
      user: { select: { name: true, isActive: true } },
      _count: { select: { products: true } },
    },
  });
  if (!store) {
    return {
      key: "store",
      label: `Pemilik toko "${subject}"`,
      scope: "publik",
      asOf,
      text:
        `Toko dengan nama "${subject}" tidak ditemukan di Mendung Tirta — ` +
        "periksa ejaan nama toko atau lihat daftar toko aktif.",
    };
  }

  const avail = await prisma.product.count({
    where: { storeId: store.id, status: "AVAILABLE", stock: { gt: 0 } },
  });
  const lines = [
    `Pemilik toko ${store.storeName}: ${store.user.name}`,
    `Status toko: ${store.isActive ? "Aktif" : "Nonaktif"}`,
    `Status akun penjual: ${store.user.isActive ? "Aktif" : "Nonaktif"}`,
    `Jumlah produk: ${store._count.products} (${avail} tersedia)`,
    store.location ? `Lokasi: ${store.location}` : "",
  ];
  return {
    key: "store",
    label: `Pemilik toko "${store.storeName}"`,
    scope: "publik",
    asOf,
    text: lines.filter(Boolean).join("\n"),
  };
}

/**
 * "Toko mana yang memiliki produk terbanyak?" → peringkat toko diurutkan
 * agregasi jumlah produk (ORDER BY _count) — bukan daftar acak.
 * Toko nonaktif tidak ikut (info publik marketplace).
 */
export async function fetchStoreRank(): Promise<ContextSection> {
  const asOf = new Date().toISOString();
  // agregasi COUNT per toko di DATABASE (bukan urutan memori) — Prisma 7 tidak
  // menyediakan orderBy _count relasi, jadi pakai SQL parameterized.
  const stores = await prisma.$queryRaw<
    Array<{ id: string; storeName: string; owner: string; total: string | number }>
  >(Prisma.sql`
    SELECT s."id" AS id, s."storeName" AS "storeName", u."name" AS owner,
           COUNT(p."id") AS total
    FROM "Store" s
    JOIN "User" u ON u."id" = s."userId"
    LEFT JOIN "Product" p ON p."storeId" = s."id"
    WHERE s."isActive" = true
    GROUP BY s."id", s."storeName", u."name"
    ORDER BY total DESC, s."storeName" ASC
    LIMIT 5
  `);
  if (stores.length === 0) {
    return {
      key: "store",
      label: "Toko dengan produk terbanyak (data aktual)",
      scope: "publik",
      asOf,
      text: "Belum ada toko aktif terdaftar di Mendung Tirta.",
    };
  }
  const availRows = await prisma.product.groupBy({
    by: ["storeId"],
    where: {
      storeId: { in: stores.map((s) => s.id) },
      status: "AVAILABLE",
      stock: { gt: 0 },
    },
    _count: { _all: true },
  });
  const availBy = new Map(availRows.map((r) => [r.storeId, r._count._all]));
  const text = stores
    .map(
      (s, i) =>
        `${i + 1}. ${s.storeName} — ${Number(s.total)} produk ` +
        `(${availBy.get(s.id) ?? 0} tersedia) — pemilik: ${s.owner}`,
    )
    .join("\n");
  return {
    key: "store",
    label: "Toko dengan produk terbanyak (data aktual)",
    scope: "publik",
    asOf,
    text,
  };
}

/**
 * "Produk paling mahal dan paling murah?" → MIN & MAX harga aktual
 * (2 query kecil berparallel, tanpa membanjiri seluruh daftar katalog).
 */
export async function fetchProductExtremes(): Promise<ContextSection> {
  const asOf = new Date().toISOString();
  const sel = {
    name: true,
    price: true,
    stock: true,
    status: true,
    category: { select: { name: true } },
    store: { select: { storeName: true } },
  } as const;
  const [hi, lo] = await Promise.all([
    prisma.product.findFirst({
      where: { status: { not: "HIDDEN" } },
      orderBy: { price: "desc" },
      select: sel,
    }),
    prisma.product.findFirst({
      where: { status: { not: "HIDDEN" } },
      orderBy: { price: "asc" },
      select: sel,
    }),
  ]);
  const line = (p: typeof hi, tag: string): string =>
    p
      ? `${tag}: ${p.name} — ${rupiah(Number(p.price))} (stok ${p.stock}, status ${p.status}, ` +
        `kategori ${p.category.name}, ${p.store.storeName})`
      : `${tag}: katalog belum memiliki produk.`;
  return {
    key: "extremes",
    label: "Produk dengan harga termahal & termurah (data aktual)",
    scope: "publik",
    asOf,
    text: [line(hi, "Termahal"), line(lo, "Termurah")].join("\n"),
  };
}

/**
 * "Siapa pembeli yang memesan ikan kerapu?" → daftar pembeli per produk dari
 * tabel Order/OrderItem. Cakupan per peran: ADMIN semua; SELLER hanya produk
 * toko sendiri; BUYER ditolak (data internal — tanpa query). Nama pembeli
 * saja (tanpa email/telefon/alamat); maks. 10 pembeli + 100 item terakhir.
 */
export async function fetchProductBuyers(
  user: SafeUser,
  message: string,
): Promise<ContextSection> {
  const asOf = new Date().toISOString();
  const scope: ContextScope = user.role === "ADMIN" ? "admin" : "toko-sendiri";

  // BUYER: daftar pembeli bersifat internal — TANPA query sama sekali.
  if (user.role === "BUYER") {
    return {
      key: "orders",
      label: "Keterbatasan data pembeli produk",
      scope: "admin",
      asOf,
      text:
        "Daftar pembeli produk adalah data internal — hanya dapat dilihat oleh admin " +
        "(dan penjual untuk produk toko sendiri).",
    };
  }

  // Buang bagian pertanyaan → sisa = nama produk yang dipesan.
  const subject = message
    .toLowerCase()
    .replace(/^.*?\b(?:memesan|membeli|dipesan|dibeli|beli(?:kan)?)\b\s*/, " ")
    .replace(
      /\b(?:siapa|saja|yang|pembeli|buyer|konsumen|customer|produk|barang|dari|untuk|di|ini|itu)\b/g,
      " ",
    )
    .replace(/[?!,."']/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!subject) {
    return {
      key: "orders",
      label: "Klarifikasi produk",
      scope,
      asOf,
      text: 'Produk apa yang dimaksud? Sebutkan nama produknya (mis. "Siapa pembeli yang memesan ikan kerapu?").',
    };
  }

  const products = await prisma.product.findMany({
    where: { name: { contains: subject, mode: "insensitive" }, status: { not: "HIDDEN" } },
    select: { id: true, name: true, store: { select: { userId: true } } },
    take: 10,
  });
  if (products.length === 0) {
    return {
      key: "orders",
      label: `Pembeli produk "${subject}"`,
      scope,
      asOf,
      text: `Produk "${subject}" tidak ditemukan di katalog — tidak ada data pembeli untuk produk tersebut.`,
    };
  }

  // SELLER: hanya produk toko milik sendiri — selain itu penolakan jujur.
  let visible = products;
  if (user.role === "SELLER") {
    visible = products.filter((p) => p.store.userId === user.id);
    if (visible.length === 0) {
      return {
        key: "orders",
        label: "Keterbatasan data pembeli produk",
        scope: "toko-sendiri",
        asOf,
        text:
          "Produk tersebut bukan dari toko Anda — data pembeli hanya dapat dilihat " +
          "oleh admin (penjual untuk produk toko sendiri).",
      };
    }
  }

  const items = await prisma.orderItem.findMany({
    where: { productId: { in: visible.map((p) => p.id) } },
    orderBy: { order: { createdAt: "desc" } },
    take: 100,
    include: {
      order: {
        select: {
          id: true,
          status: true,
          createdAt: true,
          buyer: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Kelompokkan per pembeli (urutan item = pesanan terbaru dulu → yang pertama
  // dicatat adalah pesanan terakhir pembeli tersebut).
  const byBuyer = new Map<
    string,
    { name: string; units: number; lastId: string; lastStatus: string; lastAt: Date }
  >();
  for (const it of items) {
    const key = it.order.buyer.id;
    const existing = byBuyer.get(key);
    if (existing) existing.units += it.quantity;
    else
      byBuyer.set(key, {
        name: it.order.buyer.name,
        units: it.quantity,
        lastId: it.order.id,
        lastStatus: it.order.status,
        lastAt: it.order.createdAt,
      });
  }

  const ranked = [...byBuyer.values()].sort((a, b) => b.units - a.units);
  const shown = ranked.slice(0, 10);
  const statusLabel = (s: string): string =>
    ORDER_STATUS_LABEL[s as OrderStatusValue] ?? s;
  const lines = shown.map(
    (v, i) =>
      `${i + 1}. ${v.name} — total ${v.units} unit — pesanan terakhir ` +
      `#${v.lastId.slice(0, 8)} (${statusLabel(v.lastStatus)}, ${fmtDate(v.lastAt)})`,
  );
  if (ranked.length > shown.length) {
    lines.push(`+${ranked.length - shown.length} pembeli lain tidak ditampilkan (batas tampilan).`);
  }

  const names =
    visible.length === 1
      ? visible[0].name
      : `produk mengandung "${subject}" (${visible.length} produk cocok)`;
  return {
    key: "orders",
    label: `Pembeli ${names} (${ranked.length} pembeli)`,
    scope,
    asOf,
    text:
      lines.length > 0
        ? lines.join("\n")
        : "Belum ada pesanan untuk produk tersebut — belum ada pembeli yang tercatat.",
  };
}

/**
 * STORE_INFO — berurutan: pemilik toko ("siapa pemilik toko X?") → peringkat
 * produk toko ("toko mana yang paling banyak produk?") → penjual dari subjek
 * produk ("siapa penjual ikan kerapu?") → profil/daftar toko seperti biasa.
 * Di-export untuk unit test (mengikuti pola fetchRolesSection).
 */
export async function fetchStoreInfo(
  message: string,
  keywords: string[],
): Promise<ContextSection | null> {
  const owner = await fetchStoreOwner(message);
  if (owner) return owner;
  if (STORE_RANK_RE.test(message.toLowerCase())) return fetchStoreRank();
  const fromProduct = await fetchSellerOfProduct(message);
  if (fromProduct) return fromProduct;
  return fetchStores(keywords, { anyIfEmpty: true });
}

/** Informasi akun pengguna yang sedang login — aman, hanya milik sendiri. */
async function fetchAccount(user: SafeUser, message: string): Promise<ContextSection | null> {
  const dbUser = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      address: true,
      isActive: true,
      createdAt: true,
      store: { select: { storeName: true, description: true, location: true, isActive: true } },
      _count: { select: { orders: true, reviews: true } },
    },
  });
  if (!dbUser) return null;

  const roleLabel: Record<string, string> = {
    BUYER: "Pembeli",
    SELLER: "Penjual",
    ADMIN: "Admin",
  };

  const lines = [
    `Nama: ${dbUser.name}`,
    `Email: ${dbUser.email}`,
    `Peran: ${roleLabel[dbUser.role] ?? dbUser.role}`,
    `Alamat: ${dbUser.address ?? "(belum diisi)"}`,
    `Status akun: ${dbUser.isActive ? "Aktif" : "Nonaktif"}`,
    `Bergabung sejak: ${fmtDate(dbUser.createdAt)}`,
    `Total pesanan: ${dbUser._count.orders}`,
    `Total ulasan: ${dbUser._count.reviews}`,
  ];

  if (dbUser.role === "SELLER" && dbUser.store) {
    lines.push(
      `Toko: ${dbUser.store.storeName}`,
      `Status toko: ${dbUser.store.isActive ? "Aktif" : "Nonaktif"}`,
      dbUser.store.location ? `Lokasi toko: ${dbUser.store.location}` : "",
      dbUser.store.description ? `Deskripsi: ${dbUser.store.description.slice(0, 200)}` : "",
    );
  }

  // Pertanyaan "cara mengubah profil/password" → panduan navigasi aktual.
  if (/\bcara\b|mengubah|mengganti|bagaimana/.test(message.toLowerCase())) {
    lines.push(
      'Panduan: ubah nama/alamat lewat menu akun → "Informasi Diri" (Profil Saya); ubah password di bagian "Ganti Password" pada halaman yang sama.',
    );
  }

  return {
    key: "account",
    label: "Informasi akun Anda",
    scope: "milik-sendiri",
    asOf: new Date().toISOString(),
    text: lines.filter(Boolean).join("\n"),
  };
}

/* ------------------------------------------------------------------ */
/* Orkestrasi                                                          */
/* ------------------------------------------------------------------ */

/** Ambil ulang produk dari DB berdasarkan ID riwayat (validasi data terkini). */
async function fetchProductsByIds(ids: string[]): Promise<AiProduct[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.product.findMany({
    where: { id: { in: ids }, status: { not: "HIDDEN" } },
    select: {
      id: true,
      name: true,
      price: true,
      stock: true,
      image: true,
      status: true,
      store: { select: { storeName: true } },
      category: { select: { name: true } },
      reviews: { select: { rating: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .filter((id) => byId.has(id))
    .map((id) => {
      const r = byId.get(id)!;
      const avg =
        r.reviews.length > 0
          ? r.reviews.reduce((a, x) => a + x.rating, 0) / r.reviews.length
          : 0;
      return {
        id: r.id,
        name: r.name,
        price: Number(r.price),
        stock: r.stock,
        image: r.image,
        storeName: r.store.storeName,
        categoryName: r.category.name,
        rating: Math.round(avg * 10) / 10,
        ratingCount: r.reviews.length,
        status: r.status,
      };
    });
}

/**
 * Susun konteks chatbot untuk satu pertanyaan:
 * pencarian katalog (hanya bila relevan dengan topik produk) + fokus produk
 * (untuk pertanyaan SATU produk — tanpa ringkasan katalog) + section
 * sesuai intent & PERAN sesi login + produk dari konteks percakapan
 * sebelumnya (divalidasi ulang dari DB — bukan ingatan model).
 * Melempar bila DB gagal → route menangkap dan menjawab dengan pesan
 * "layanan data tidak tersedia" (tanpa stack trace).
 *
 * Filter gabungan (harga, subjek produk, kategori, toko, stok, rating,
 * sorting) diekstrak dari bahasa alami; subjek divalidasi ke data kategori
 * AKTUAL di database dan bisa direten dari riwayat ("di bawah 50000" setelah
 * "hasil laut" tetap memakai subjek "hasil laut" selama relevan).
 * Semua kondisi diterapkan sebagai AND di level database.
 */
/** Rujukan lanjutan ("harganya", "stoknya", "yang tadi", "masih ada") —
 *  penanda pertanyaan lanjutan yang harus dijawab dari konteks/riwayat,
 *  bukan dianggap permintaan daftar katalog. */
const FOLLOWUP_REF_RE =
  /\bharganya\b|\bstoknya\b|\bmasih ada\b|detailnya|yang tadi|\bukuran lain\b|\bvarian lain\b/i;

/** Pesan yang HANYA berisi nomor halaman ("halaman 2", "halaman ke-3?"). */
const PAGE_ONLY_RE = /^\s*halaman\s+(?:ke-)?(\d+)\s*[?.!]*\s*$/i;

/**
 * Retensi daftar: "halaman 2" (tanpa konteks) menyambungkan permintaan DAFTAR
 * terakhir dari riwayat — target role ("Siapa saja buyer halaman 2"), filter
 * status, dan pencarian tetap sama; hanya halaman yang berganti. Tanpa riwayat
 * daftar yang cocok → null (pesan dibiarkan utuh, tidak pernah menebak).
 */
function resolveListPageFollowUp(message: string, recent?: string[]): string | null {
  const m = PAGE_ONLY_RE.exec(message);
  if (!m) return null;
  const prev = [...(recent ?? [])].reverse().find((r) => detectUserListTarget(r) !== null);
  if (!prev) return null;
  return `${prev.replace(/[?.!]+$/, "")} halaman ${m[1]}`;
}

export async function buildChatContext(
  user: SafeUser,
  message: string,
  opts?: {
    contextProductIds?: string[];
    /** Teks pesan user sebelumnya di sesi ini (retensi subjek/filter). */
    recentUserMessages?: string[];
  },
): Promise<ChatContext> {
  // Sambungan halaman daftar ("halaman 2" setelah daftar sebelumnya) —
  // disempurnakan SEBELUM klasifikasi supaya intent & target mengikuti
  // permintaan daftar terakhir, bukan jatuh ke pertanyaan tanpa konteks.
  const effectiveMessage =
    resolveListPageFollowUp(message, opts?.recentUserMessages) ?? message;

  // Klasifikasi maksud (taksonomi CHATBOT_INTENTS) — deterministik dulu, disempurnakan
  // Gemini bila ragu. JALAN SEBELUM query database: hasilnya menentukan
  // fetcher mana (termasuk pendapatan per peran) yang boleh berjalan.
  const botIntent = await classifyChatbotIntent(effectiveMessage, opts?.recentUserMessages);

  const baseKeywords = extractKeywords(message);
  const baseFilters = parseProductFilters(message);
  const intents = detectIntents(message);
  const countKinds = detectCountQuery(message);
  const hasCount = countKinds.length > 0;

  // Augmentasi: intent utama melengkapi deteksi fetcher — mencakup hasil
  // klasifikasi Gemini yang menangkap sinonim di luar kosakata deterministik
  // ("laporan cuan bulan ini" → SALES_REPORT → ringkasan penjualan).
  if (botIntent.intent === "SERVICE_INFO") intents.add("appinfo");
  if (botIntent.intent === "ACCOUNT_INFO") intents.add("account");
  if (botIntent.intent === "STORE_INFO") intents.add("store");
  if (botIntent.intent === "ORDER_STATUS") intents.add("order");
  if (botIntent.intent === "MARKETPLACE_STATS") intents.add("stats");
  if (botIntent.intent === "SALES_REPORT") intents.add("sales");

  // Katalog hanya relevan untuk pertanyaan berbasis produk — jangan kirim
  // daftar produk untuk pertanyaan akun/statistik/hitungan/pesanan/info aplikasi.
  const strongNonCatalog =
    intents.has("stats") ||
    intents.has("appinfo") ||
    intents.has("account") ||
    hasCount ||
    NON_CATALOG_INTENTS.has(botIntent.intent);
  const catalogIntent =
    intents.has("product") || intents.has("lowstock") || intents.has("outofstock");

  // Subjek produk — diekstrak dari frasa lalu divalidasi ke kategori aktual.
  // Ikut di-resolve untuk pertanyaan hitungan berfilter ("berapa jumlah produk
  // hasil laut?"), tapi TIDAK untuk intent akun/statistik/layanan/non-katalog.
  const subjectAllowed =
    !intents.has("stats") &&
    !intents.has("appinfo") &&
    !intents.has("account") &&
    !NON_CATALOG_INTENTS.has(botIntent.intent);
  let subject: ProductSubject | null = null;
  let subjectAmbiguity: { phrase: string; options: string[] } | undefined;
  // true bila subjek datang dari retensi riwayat (bukan dari pesan sendiri) —
  // retensi usang yang tidak menghasilkan produk akan dilepas kembali.
  let subjectRetained = false;
  if (subjectAllowed) {
    const resolved = await resolveProductSubject(message);
    if (resolved.ambiguous && resolved.ambiguous.length > 0) {
      subjectAmbiguity = {
        phrase: extractSubjectPhrase(message) ?? resolved.ambiguous[0],
        options: resolved.ambiguous,
      };
    }
    subject = resolved.subject;
    // Retensi subjek dari riwayat: "di bawah 50000" setelah "hasil laut"
    // memakai subjek "hasil laut" — selama pesan saat ini masih berupa
    // filter harga dan topik tidak berpindah (strongNonCatalog sudah dicek).
    if (!subject && !subjectAmbiguity && baseFilters.price) {
      const previous = [...(opts?.recentUserMessages ?? [])].reverse().slice(0, 4);
      for (const prev of previous) {
        const prior = await resolveProductSubject(prev);
        if (prior.subject) {
          subject = prior.subject;
          subjectRetained = true;
          break;
        }
      }
    }
  }

  // Parameter terstruktur: hasil ekstraksi deterministik + (bila ada)
  // parameter dari klasifikasi Gemini — hanya mengisi kolom yang kosong.
  const filters: ProductFilter = mergeIntentParams(
    { ...baseFilters, subject: subject ?? undefined },
    botIntent.params,
  );
  const hasAnyFilter = !!(
    filters.price ||
    filters.subject ||
    filters.category ||
    filters.store ||
    filters.inStock !== undefined ||
    filters.browse ||
    filters.minRating !== undefined ||
    filters.sortBy
  );
  const catalogRelevant =
    !strongNonCatalog &&
    !subjectAmbiguity &&
    (catalogIntent || hasAnyFilter || (baseKeywords.length > 0 && !intents.has("order")));

  // Kata kunci pencarian: buang kata yang sudah menjadi subjek/kategori/toko —
  // subjek dipakai sebagai kondisi AND ketat di database, bukan OR keyword.
  // Kata toko ("dari toko X") ikut dibuang: filter toko sudah jadi kondisi AND;
  // sisa keyword dari nama toko justru menyaring produk berdasarkan nama/kategori
  // PRODUK ("pancing" → kategori Alat Pancing) dan menjatuhkan produk toko
  // lain yang namanya tak mengandung kata tersebut (bug J8).
  const subjectWords = new Set(
    [filters.subject?.phrase, filters.subject?.value, filters.category, filters.store]
      .filter((s): s is string => !!s)
      .flatMap((s) => s.toLowerCase().split(/\s+/)),
  );
  const keywords = baseKeywords.filter((kw) => !subjectWords.has(kw));
  // Rujukan lanjutan ("-nya"/"yang tadi"/"masih ada") BUKAN permintaan daftar
  // katalog — jangan tambahkan filter inStock yang mengubahnya jadi jalur
  // "filtered" (regresi Q13: "Berapa stoknya?" harus dijawab dari konteks).
  if (keywords.length === 0 && !hasAnyFilter && catalogIntent && !FOLLOWUP_REF_RE.test(message)) {
    // Pertanyaan katalog umum (mis. "apa saja", "ada apa", "katalog produk")
    // yang tidak menyisakan keyword spesifik → telusuri SEMUA produk terlihat
    // tanpa filter stok yang tidak diminta (status ≠ HIDDEN; produk habis
    // tetap tampil beserta labelnya — permintaan "stok habis" = filter sendiri).
    filters.browse = true;
  }

  // Cari produk dengan filter gabungan (subjek + harga + kriteria lain).
  let products = catalogRelevant && (keywords.length > 0 || hasAnyFilter || filters.inStock !== undefined || filters.browse)
    ? await searchCatalog(keywords, filters)
    : [];
  // Retensi riwayat yang tidak menghasilkan apa pun → lepas subjeknya agar
  // jawaban melebar ke filter harga (jawaban jujur, bukan "tidak ada" usang).
  // Subjek dari pesan sendiri TIDAK pernah dilepas (tetap ketat/jujur).
  if (products.length === 0 && subjectRetained && filters.subject) {
    filters.subject = undefined;
    subjectRetained = false;
    if (catalogRelevant) {
      products = baseKeywords.length > 0
        ? await searchCatalog(baseKeywords, filters)
        : await searchCatalog([], filters);
    }
  }

  // Produk dari konteks percakapan sebelumnya (ID valid dari sesi yang sama,
  // divalidasi ulang dari DB — harga/stok terkini, bukan ingatan model).
  const contextProducts = await fetchProductsByIds(opts?.contextProductIds ?? []);

  // Fokus produk: nama produk yang cocok dengan keyword (toleran ILIKE).
  // - 1 cocok → fokus (jawab spesifik, bukan ringkasan seluruh katalog)
  // - ≥2 cocok → ambigu → minta klarifikasi
  // Dilewati saat filter harga aktif dan pertanyaan BUKAN atribut satu produk —
  // user yang meminta filter ingin DAFTAR produk, bukan detail satu produk.
  // Dilewati saat filter harga ATAU TOKO aktif dan pertanyaan BUKAN atribut
  // satu produk — user yang meminta filter ingin DAFTAR produk, bukan detail
  // satu produk. Fokus toko rawan salah: keyword fokus berasal dari NAMA TOKO,
  // bukan nama produk, sehingga bisa menyempitkan daftar toko jadi subset
  // ("Produk dari toko X" harus menampilkan SEMUA produk toko).
  const skipFocus =
    (!!filters.price || !!filters.store) && !isSingleProductQuestion(message);
  const focusMatches = catalogRelevant && baseKeywords.length > 0 && !skipFocus
    ? await findFocusProducts(baseKeywords, filters)
    : [];
  const focus = focusMatches.length === 1 ? focusMatches[0] : null;
  const focusCandidates = focus ? [] : focusMatches;
  // Pertanyaan lanjutan ("berapa harganya?") dengan tepat 1 produk di riwayat
  // → fokus ke produk riwayat (stok/harga tetap divalidasi ulang dari DB).
  let focusProduct: AiProduct | null = focus;
  if (!focusProduct && focusCandidates.length === 0 && contextProducts.length === 1 && intents.has("product") && !hasCount) {
    focusProduct = contextProducts[0];
  }
  // Pertanyaan lanjutan tanpa referensi jelas (tanpa nama & tanpa konteks)
  // → jangan tampilkan dump katalog — minta klarifikasi.
  const ambiguousFollowUp =
    catalogRelevant &&
    !focusProduct &&
    focusCandidates.length === 0 &&
    contextProducts.length === 0 &&
    FOLLOWUP_REF_RE.test(message) &&
    !/\bapa saja\b|\bkatalog\b|\bdaftar\b|semua produk|produk yang (?:tersedia|ada)|produk apa/i.test(message);

  // Subjek name-mode yang TIDAK cocok dengan produk mana pun ("status",
  // "stoknya", "perahu") → LEPAS dari filter final. Subjek semacam ini hanya
  // bisa mematikan katalog & menyaring konteks percakapan tanpa guna
  // (regresi pertanyaan lanjutan "Berapa stoknya?" yang terbuang). Pencarian
  // sudah dijalankan dengan subjeknya (hasil tetap jujur: kosong), lalu
  // dicari ulang tanpa subjek. Dilewati untuk pertanyaan JUMLUH —
  // "berapa jumlah produk perahu?" tetap dijawab 0 lewat filter name
  // (bukan total seluruh produk).
  if (filters.subject && filters.subject.mode === "name" && !hasCount && products.length === 0) {
    const subjectMatches = await prisma.product.count({
      where: { name: { contains: filters.subject.value, mode: "insensitive" } },
    });
    if (subjectMatches === 0) {
      filters.subject = undefined;
      if (catalogRelevant) {
        // Subjek tak cocok dilepas. Bila tak ada kriteria tersisa,
        // searchCatalog([], {}) SELALU kosong (guard anti-dump) → produk 0
        // tanpa query bermakna → AI kehilangan konteks dan bisa mengarang
        // "tidak ada produk". Terapkan default telusuri katalog seperti
        // pertanyaan umum tanpa subjek (diabaikan untuk rujukan lanjutan —
        // "varian lain" tetap minta klarifikasi, bukan dump katalog).
        if (
          baseKeywords.length === 0 &&
          !filters.price &&
          !filters.category &&
          !filters.store &&
          filters.inStock === undefined &&
          filters.browse === undefined &&
          filters.minRating === undefined &&
          !filters.sortBy &&
          !FOLLOWUP_REF_RE.test(message)
        ) {
          filters.browse = true;
        }
        products = baseKeywords.length > 0
          ? await searchCatalog(baseKeywords, filters)
          : await searchCatalog([], filters);
      }
    }
  }

  const jobs: (Promise<ContextSection | null> | null)[] = [];

  // Pertanyaan ROLE (jenis/hak akses/daftar pengguna) → HANYA section role.
  // Pemisahan tegas: tanpa profil akun, tanpa hitungan, tanpa toko/katalog —
  // "Ada apa saja role pengguna?" tidak boleh terjawab profil "Siapa saya?".
  const roleInfoIntent =
    botIntent.intent === "USER_ROLES" ||
    botIntent.intent === "ROLE_PERMISSION" ||
    botIntent.intent === "USER_LIST";

  if (roleInfoIntent) {
    jobs.push(fetchRolesSection(user, botIntent.intent, effectiveMessage));
  } else {
    // Hitungan spesifik ("berapa jumlah penjual?") → jawaban HANYA entitas yang
    // ditanya. Diprioritaskan di atas ringkasan statistik umum; dilewati bila ada
    // fokus produk bernama (entitas spesifik > hitungan agregat).
    // Hitungan produk DENGAN filter (subjek/harga) → query terfilter, bukan total umum.
    if (hasCount && !focusProduct && focusCandidates.length === 0) {
      for (const kind of countKinds) {
        const productKind =
          kind === "totalProducts" || kind === "availableProducts" || kind === "outOfStockProducts";
        if (productKind && (filters.price || filters.subject || filters.category || filters.store)) {
          jobs.push(fetchFilteredCountSection(kind, filters));
        } else {
          jobs.push(fetchCountSection(user, kind, message));
        }
      }
      // "Ada berapa pengguna dan siapa namanya?" → hitungan + DAFTAR identitas
      // nyata dari database (bukan angka saja) — daftar tetap mengikuti hak
      // akses peran (identitas internal hanya untuk admin).
      if (
        countKinds.includes("user") &&
        /\bsiapa\s+(?:saja\s+)?nama|\bdan\s+siapa\b|\bnamanya\b/.test(message.toLowerCase())
      ) {
        jobs.push(fetchRolesSection(user, "USER_LIST", effectiveMessage));
      }
    }
    // Ringkasan katalog hanya bila TIDAK sedang fokus ke produk tertentu dan
    // TIDAK sedang memfilter (pertanyaan berfilter menampilkan daftar terfilter,
    // jangan dibumbui ringkasan seluruh katalog).
    if (
      catalogRelevant &&
      !focusProduct &&
      focusCandidates.length === 0 &&
      !ambiguousFollowUp &&
      !hasAnyFilter
    ) {
      jobs.push(fetchCatalogSummary()); // "kosong" vs "habis" tidak tertukar
    }
    // Ekstrem harga ("produk paling mahal dan paling murah?") → MIN/MAX aktual.
    if (detectProductExtremes(message) && !hasCount) {
      jobs.push(fetchProductExtremes());
    }
    // Ulasan — bila intent reviews atau ada fokus produk
    if (intents.has("reviews") || focusProduct) {
      const focusIds = focusProduct ? [focusProduct.id] : focusCandidates.slice(0, 2).map((p) => p.id);
      jobs.push(fetchReviews(focusIds.length > 0 ? focusIds : undefined));
    }
    // Daftar pesanan dilewati bila yang ditanya JUMLUHnya (hitungan menang).
    // "Siapa pembeli yang memesan produk X?" → fetcher khusus pembeli produk
    // (otorisasi per peran di dalam fetchProductBuyers).
    if (detectBuyersOfProduct(message) && !hasCount) {
      jobs.push(fetchProductBuyers(user, message));
    } else if (
      intents.has("order") &&
      !(hasCount && (countKinds.includes("orders") || countKinds.includes("paidPayments")))
    ) {
      jobs.push(fetchOrders(user, message));
    }
    // Pendapatan / laporan penjualan — query khusus per PERAN (intent REVENUE /
    // SALES_REPORT). Sumber angka HANYA DB; pembatasan peran ditentukan di
    // fetchRevenue (BUYER tanpa query → penolakan jujur). `message` membawa
    // filter periode ("bulan ini") dan ranking produk terbesar.
    const isRevenue = botIntent.intent === "REVENUE";
    const isSalesReport = botIntent.intent === "SALES_REPORT";
    if (isRevenue || isSalesReport) jobs.push(fetchRevenue(user, message));
    if (isSalesReport && user.role === "SELLER") jobs.push(fetchSales(user));
    if (isSalesReport && user.role === "ADMIN") jobs.push(fetchStats(user));
    if (intents.has("sales") && !isRevenue && !isSalesReport) jobs.push(fetchSales(user));
    // Ringkasan statistik umum HANYA bila TIDAK ada hitungan spesifik —
    // "berapa jumlah penjual" tidak boleh membanjiri seluruh statistik.
    if (intents.has("stats") && !hasCount) {
      jobs.push(fetchStats(user));
      if (user.role !== "ADMIN") jobs.push(fetchMarketReach(user, message));
      // Penjual menanyakan statistiknya sendiri ("statistik toko saya") →
      // ringkasan penjualan toko (bila belum dijadwalkan oleh intent sales).
      if (
        user.role === "SELLER" &&
        !intents.has("sales") &&
        !isSalesReport &&
        /\b(?:saya|toko\s+saya|akun\s+saya|sendiri)\b/i.test(message)
      ) {
        jobs.push(fetchSales(user));
      }
    }
    if (intents.has("lowstock")) jobs.push(fetchLowStock(user, message));
    // Daftar stok habis dilewati bila yang ditanya JUMLUH produk habis.
    if (
      intents.has("outofstock") &&
      !(hasCount && countKinds.includes("outOfStockProducts"))
    ) {
      jobs.push(fetchOutOfStock(user, message));
    }
    // Profil toko (ILIKE) dilewati bila yang ditanya jumlah penjual/toko.
    // STORE_INFO → pemilik toko / peringkat produk toko / "siapa penjual
    // <produk>?"; selain itu → profil/daftar toko. Pertanyaan pendapatan/laporan
    // BERKAIT MILIK SENDIRI tidak perlu memunculkan profil toko (fokus ke angka).
    const selfRef = /\b(?:saya|aku|sendiri)\b/i.test(message);
    if (
      intents.has("store") &&
      !(hasCount && (countKinds.includes("store") || countKinds.includes("seller"))) &&
      !((isRevenue || isSalesReport) && selfRef)
    ) {
      jobs.push(
        botIntent.intent === "STORE_INFO"
          ? fetchStoreInfo(message, keywords)
          : fetchStores(keywords),
      );
    }
    // Akun tidak ikut saat pertanyaan hitungan ("terdaftar" mengandung kata "daftar").
    if (intents.has("account") && !hasCount) jobs.push(fetchAccount(user, message));
    if (intents.has("appinfo")) jobs.push(fetchAppInfo());
  }

  const sections = (await Promise.all(jobs)).filter((s): s is ContextSection => s !== null);

  return {
    products,
    sections,
    contextProducts,
    focus: focusProduct,
    focusCandidates,
    ambiguousFollowUp,
    filters,
    subjectAmbiguity,
    intent: botIntent.intent,
    generatedAt: new Date().toISOString(),
  };
}

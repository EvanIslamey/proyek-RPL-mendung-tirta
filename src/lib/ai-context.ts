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
import { searchCatalog, findFocusProducts, extractKeywords, type AiProduct } from "./ai";
import type { SafeUser } from "./auth";

export type ContextScope = "publik" | "milik-sendiri" | "toko-sendiri" | "admin";

export type ContextSection = {
  key:
    | "orders"
    | "sales"
    | "stats"
    | "market"
    | "lowstock"
    | "outofstock"
    | "store"
    | "account"
    | "catalog"
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

/** Kategori intent — menentukan fetcher mana yang boleh dijalankan. */
export type ChatIntent =
  | "product"
  | "order"
  | "sales"
  | "stats"
  | "lowstock"
  | "outofstock"
  | "store"
  | "account"
  | "appinfo";

/**
 * Deteksi jenis pertanyaan (murni, tanpa AI — bisa diuji unit test).
 * Hanya menentukan FETCHER mana yang boleh dijalankan; otorisasi tetap
 * diputuskan per peran di `buildChatContext`.
 */
export function detectIntents(message: string): Set<ChatIntent> {
  const m = message.toLowerCase();
  const has = (...words: string[]) => words.some((w) => m.includes(w));
  const intents = new Set<ChatIntent>();

  // A. Produk / katalog (harga, ketersediaan, kategori, rekomendasi…)
  if (
    has(
      "harga", "produk", "katalog", "tersedia", "stok", "kategori", "beli",
      "rekomendasi", "murah", "mahal", "ready", "varian", "ukuran", "ulasan",
      "review", "rating", "diskon", "restock", "masih ada", "ada nggak",
      "ada gak", "mau cari", "cari", "dijual",
    )
  ) {
    intents.add("product");
  }
  // B. Pesanan
  if (has("pesanan", "pembelian", "order", "checkout", "bayar", "dibayar", "dikirim")) {
    intents.add("order");
  }
  // Penjualan (penjual)
  if (has("penjualan", "omzet", "pendapatan", "revenue", "terjual", "penghasilan", "laku")) {
    intents.add("sales");
  }
  // Statistik marketplace (jawaban penuh khusus ADMIN)
  if (
    has(
      "statistik", "statistic", "rekap", "jumlah pengguna", "total pengguna",
      "performa platform", "jumlah penjual", "jumlah pembeli", "total penjual",
      "total pembeli", "berapa penjual", "berapa pembeli", "banyak penjual",
      "banyak pembeli", "jumlah toko", "berapa toko",
    )
  ) {
    intents.add("stats");
  }
  // Stok menipis vs stok habis — "hampir habis" bukan habis.
  const wantsLowStock = has("stok menipis", "hampir habis", "stok tersisa", "stok sedikit", "menipis");
  if (wantsLowStock) {
    intents.add("lowstock");
  }
  const withoutNearly = m.replace(/hampir habis/g, " ");
  if (/(^|[^a-z])habis|out of stock|sold out|stok 0|kehabisan/.test(withoutNearly)) {
    intents.add("outofstock");
  }
  // Toko / penjual (profil toko publik)
  if (has("toko", "penjual", "seller", "penjualnya", "tokonya", "siapa yang jual")) {
    intents.add("store");
  }
  // C. Akun sendiri
  if (
    has(
      "siapa saya", "akun saya", "profil saya", "informasi akun", "nama saya", "email saya",
      "login sebagai", "kapan daftar", "bergabung sejak", "role saya", "peran saya",
      "ubah profil", "ganti profil", "edit profil", "akun apa", "profil apa",
      "daftar kapan", "sejak kapan", "peran apa", "role apa",
      "alamat saya", "ganti nama", "ganti alamat", "ubah alamat", "ubah nama",
      // kata kunci individual untuk menangkap variasi
      "daftar", "sejak", "peran", "role", "akun", "profil", "email", "password", "sandi", "kata sandi"
    )
  ) {
    intents.add("account");
  }
  // E. Informasi aplikasi (layanan, tentang kami, panduan)
  if (
    has(
      "layanan", "tentang kami", "apa itu mendung", "siapa mendung", "tentang mendung",
      "cara belanja", "cara beli", "cara pesan", "cara daftar", "cara mendaftar",
      "cara checkout", "cara bayar", "gimana cara", "bagaimana cara", "cara menggunakan",
      "panduan", "bantuan", "faq", "fitur apa", "layanan apa", "bisa apa",
    )
  ) {
    intents.add("appinfo");
  }
  return intents;
}

/* ------------------------------------------------------------------ */
/* Fetcher per topik — semua parameterized Prisma, dibatasi per peran. */
/* ------------------------------------------------------------------ */

/** Pesanan pembeli: milik sendiri saja. Penjual: order berisi produk toko. */
async function fetchOrders(user: SafeUser): Promise<ContextSection | null> {
  const asOf = new Date().toISOString();

  if (user.role === "BUYER") {
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
      label: "Pesanan pembeli yang sedang login (5 terbaru)",
      scope: "milik-sendiri",
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
        order: { select: { id: true, status: true, createdAt: true, total: true } },
        product: { select: { name: true } },
      },
    });
    if (items.length === 0) return null;

    const text = items
      .map(
        (i) =>
          `#${i.order.id.slice(0, 8)} | ${fmtDate(i.order.createdAt)} | status: ${i.order.status}` +
          ` | produk toko: ${i.product.name} x${i.quantity} | nilai pesanan: ${rupiah(Number(i.order.total))}`,
      )
      .join("\n");

    return {
      key: "orders",
      label: `Pesanan berisi produk toko "${store.storeName}" (8 terbaru)`,
      scope: "toko-sendiri",
      asOf,
      text,
    };
  }

  return null; // ADMIN memakai section statistik (sudah memuat rekap pesanan).
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
  const revenueRows = await prisma.$queryRaw<{ total: string | number }[]>(Prisma.sql`
    SELECT COALESCE(SUM(oi.price * oi.quantity), 0) AS total
    FROM "OrderItem" oi
    JOIN "Product" p ON p.id = oi."productId"
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE p."storeId" = ${store.id} AND o.status <> 'CANCELLED'
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
    `Pendapatan kotor dari item toko: ${rupiah(revenue)}`,
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

/** Statistik marketplace — hanya ADMIN. */
async function fetchStats(user: SafeUser): Promise<ContextSection | null> {
  if (user.role !== "ADMIN") return null;

  const [users, products, orders, paidAgg, lowStock] = await Promise.all([
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
  ]);

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

  const text = [
    `Jumlah pengguna total: ${users.reduce((a, u) => a + u._count, 0)}`,
    `Jumlah penjual (role SELLER): ${roleCount("SELLER")}`,
    `Jumlah pembeli (role BUYER): ${roleCount("BUYER")}`,
    `Jumlah admin (role ADMIN): ${roleCount("ADMIN")}`,
    fmt(products.map((p) => ({ status: p.status, _count: p._count })), "Produk per status"),
    fmt(orders.map((o) => ({ status: o.status, _count: o._count })), "Pesanan per status"),
    `Pendapatan (pesanan dibayar/dikirim/selesai): ${rupiah(Number(paidAgg._sum.total ?? 0))}`,
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
  const activeStores = await prisma.store.count({ where: { isActive: true } });
  const asksBuyer = /pembeli|buyer/.test(message.toLowerCase());

  const lines = [
    `Toko aktif di marketplace: ${activeStores} (data publik)`,
    asksBuyer
      ? "Jumlah pembeli/pengguna adalah data internal platform — hanya tersedia untuk admin."
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
  const [total, available, unavailable, hidden] = await Promise.all([
    prisma.product.count({ where: { status: { not: "HIDDEN" } } }),
    prisma.product.count({ where: { status: "AVAILABLE", stock: { gt: 0 } } }),
    prisma.product.count({
      where: {
        status: { not: "HIDDEN" },
        OR: [{ status: "OUT_OF_STOCK" }, { stock: { lte: 0 } }],
      },
    }),
    prisma.product.count({ where: { status: "HIDDEN" } }),
  ]);

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
async function fetchStores(keywords: string[]): Promise<ContextSection | null> {
  if (keywords.length === 0) return null;

  // Pencarian kata per kata (Prisma String filter tidak punya hasSome —
  // gunakan contains case-insensitive, sama dengan pola /api/admin/users).
  const orClauses = keywords.flatMap((kw) => [
    { storeName: { contains: kw, mode: "insensitive" as const } },
    { description: { contains: kw, mode: "insensitive" as const } },
    { location: { contains: kw, mode: "insensitive" as const } },
  ]);

  const stores = await prisma.store.findMany({
    where: { isActive: true, OR: orClauses },
    take: 5,
    select: {
      storeName: true,
      location: true,
      description: true,
      _count: { select: { products: true } },
    },
  });
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
 */
export async function buildChatContext(
  user: SafeUser,
  message: string,
  opts?: { contextProductIds?: string[] },
): Promise<ChatContext> {
  const keywords = extractKeywords(message);
  const intents = detectIntents(message);

  // Katalog hanya relevan untuk pertanyaan berbasis produk — jangan kirim
  // daftar produk untuk pertanyaan akun/statistik/pesanan/info aplikasi.
  const strongNonCatalog =
    intents.has("stats") || intents.has("appinfo") || intents.has("account");
  const catalogIntent =
    intents.has("product") || intents.has("lowstock") || intents.has("outofstock");
  const catalogRelevant =
    !strongNonCatalog && (catalogIntent || (keywords.length > 0 && !intents.has("order")));

  const products = catalogRelevant ? await searchCatalog(keywords) : [];

  // Produk dari konteks percakapan sebelumnya (ID valid dari sesi yang sama,
  // divalidasi ulang dari DB — harga/stok terkini, bukan ingatan model).
  const contextProducts = await fetchProductsByIds(opts?.contextProductIds ?? []);

  // Fokus produk: nama produk yang cocok dengan keyword (toleran ILIKE).
  // - 1 cocok → fokus (jawab spesifik, bukan ringkasan seluruh katalog)
  // - ≥2 cocok → ambigu → minta klarifikasi
  const focusMatches = catalogRelevant ? await findFocusProducts(keywords) : [];
  const focus = focusMatches.length === 1 ? focusMatches[0] : null;
  const focusCandidates = focus ? [] : focusMatches;
  // Pertanyaan lanjutan ("berapa harganya?") dengan tepat 1 produk di riwayat
  // → fokus ke produk riwayat (stok/harga tetap divalidasi ulang dari DB).
  let focusProduct: AiProduct | null = focus;
  if (!focusProduct && focusCandidates.length === 0 && contextProducts.length === 1 && intents.has("product")) {
    focusProduct = contextProducts[0];
  }
  // Pertanyaan lanjutan tanpa referensi jelas (tanpa nama & tanpa konteks)
  // → jangan tampilkan dump katalog — minta klarifikasi.
  const ambiguousFollowUp =
    catalogRelevant &&
    !focusProduct &&
    focusCandidates.length === 0 &&
    contextProducts.length === 0 &&
    /\bharganya\b|\bstoknya\b|\bmasih ada\b|detailnya|yang tadi|\bukuran lain\b|\bvarian lain\b/i.test(message) &&
    !/\bapa saja\b|\bkatalog\b|\bdaftar\b|semua produk|produk yang (?:tersedia|ada)|produk apa/i.test(message);

  const jobs: (Promise<ContextSection | null> | null)[] = [];
  // Ringkasan katalog hanya bila TIDAK sedang fokus ke produk tertentu
  // (pertanyaan satu produk tidak perlu ringkasan seluruh katalog).
  if (catalogRelevant && !focusProduct && focusCandidates.length === 0 && !ambiguousFollowUp) {
    jobs.push(fetchCatalogSummary()); // "kosong" vs "habis" tidak tertukar
  }
  if (intents.has("order")) jobs.push(fetchOrders(user));
  if (intents.has("sales")) jobs.push(fetchSales(user));
  if (intents.has("stats")) jobs.push(fetchStats(user));
  // "berapa jumlah penjual?" non-admin → jawab data publik (toko aktif).
  if (intents.has("stats") && user.role !== "ADMIN") jobs.push(fetchMarketReach(user, message));
  if (intents.has("lowstock")) jobs.push(fetchLowStock(user, message));
  if (intents.has("outofstock")) jobs.push(fetchOutOfStock(user, message));
  if (intents.has("store")) jobs.push(fetchStores(keywords));
  if (intents.has("account")) jobs.push(fetchAccount(user, message));
  if (intents.has("appinfo")) jobs.push(fetchAppInfo());

  const sections = (await Promise.all(jobs)).filter((s): s is ContextSection => s !== null);

  return {
    products,
    sections,
    contextProducts,
    focus: focusProduct,
    focusCandidates,
    ambiguousFollowUp,
    generatedAt: new Date().toISOString(),
  };
}

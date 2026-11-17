import { PrismaClient, Prisma } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

/**
 * UJI LENGKAP CHATBOT DATABASE — 13 KATEGORI WAJIB × 3 PERAN + KASUS DOMAIN BARU
 *
 * Setiap jawaban chatbot dibandingkan dengan GROUND TRUTH yang dihitung
 * LANGSUNG dari database (Prisma/SQL — bukan karangan, bukan asumsi schema).
 *
 * 13 kategori wajib (spesifikasi pengujian):
 *   K1  jumlah pengguna per role          → USER_COUNT (rincian admin / penolakan)
 *   K2  daftar seller                     → USER_LIST SELLER
 *   K3  daftar toko                       → USER_LIST STORE
 *   K4  produk per kategori               → filter kategori (jumlah persis GT)
 *   K5  harga bawah  (< Rp50.000)         → filter harga deterministik
 *   K6  harga atas   (> Rp50.000)         → filter harga deterministik
 *   K7  stok produk tertentu              → fokus produk ("Berapa stok ikan kerapu?")
 *   K8  stok habis                        → hitungan outOfStockProducts (jujur bila 0)
 *   K9  jumlah pesanan per status         → ORDER_COUNT (PENDING + COMPLETED, scoped peran)
 *   K10 total pendapatan                  → REVENUE (ADMIN marketplace / SELLER toko / BUYER tolak)
 *   K11 statistik ulasan                  → COUNT + AVG (publik, semua peran)
 *   K12 bahasa tidak baku / sinonim       → "Toko ada berapa sih?", "Berapa sih total seller…"
 *   K13 pertanyaan lanjutan kontekstual   → riwayat: "Ada ikan kerapu?" → "Berapa stoknya?"
 *   K14 akses data tak diizinkan          → penolakan peran tanpa angka & tanpa kebocoran
 *
 * Kasus domain data baru:
 *   B1 pemilik toko                       → fetchStoreOwner (publik, tanpa PII)
 *   B2 peringkat toko terbanyak produk    → fetchStoreRank (agregasi SQL)
 *   B3 ekstrem harga (termahal & termurah)→ fetchProductExtremes (MIN/MAX aktual)
 *   B4 pembeli suatu produk               → fetchProductBuyers (ADMIN/SELLER scope, BUYER tolak)
 *   B5 transaksi berhasil (Payment PAID)  → CountKind paidPayments (scoped peran)
 *   B6 pendapatan "bulan ini"             → REVENUE + filter periode di level DB
 *   B7 pendapatan per produk terbesar     → ranking SUM(price×quantity) per produk
 *   B8 ringkasan marketplace              → fetchStats (ADMIN) / fetchMarketReach (non-admin)
 *
 * Hak akses yang diverifikasi per pertanyaan:
 *   ADMIN  → data marketplace penuh; SELLER → hanya toko/pesanan miliknya;
 *   BUYER  → katalog publik + pesanan sendiri; penolakan TANPA angka & PII.
 *
 * Rate limit chat 10 pesan/60 detik per akun → scheduler global (2,6 dtk antar
 * pesan apa pun) + jarak minimum 7 dtk per akun (maks 9 pesan/60 dtk/akun).
 * JANGAN jalankan skrip chatbot lain bersamaan (memakai akun yang sama).
 *
 * Semua pertanyaan di bawah terbukti jalur deterministik (direct/filtered) —
 * tanpa kuota Gemini.
 *
 * Usage: npx tsx scripts/test-chatbot-db-queries.mts
 * Exit 0 = semua pemeriksaan lulus.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
/** Jarak global antar pesan (rotasi 3 peran). */
const PACE_MS = 2600;
/** Jarak minimum antar pesan SATU akun (rate limit 10/60s). */
const USER_PACE_MS = 7000;

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  status?: string;
  storeName: string;
  categoryName?: string;
  rating: number;
};

type Source = { label: string; asOf: string };

type ChatResp = {
  status: number;
  reply: string;
  products: Product[];
  sources: Source[];
  source?: string;
  fallbackReason?: string;
};

type Me = { name: string; email: string; role: string };
type RoleName = "BUYER" | "SELLER" | "ADMIN";

async function api(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<{
  status: number;
  json: Record<string, unknown> | null;
  setCookie: string[];
}> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return {
    status: res.status,
    json: json as Record<string, unknown> | null,
    setCookie: res.headers.getSetCookie?.() ?? [],
  };
}

function sessionCookie(setCookie: string[]): string | null {
  const raw = setCookie.find((c) => c.startsWith("mt_session="));
  if (!raw) return null;
  const pair = raw.split(";")[0];
  return pair && !pair.endsWith("=") ? pair : null;
}

async function login(email: string): Promise<string> {
  const r = await api("/api/auth/login", {
    method: "POST",
    body: { email, password: "password123" },
  });
  const cookie = sessionCookie(r.setCookie);
  if (!cookie) throw new Error(`login gagal: ${email}`);
  return cookie;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Scheduler rate limit: global 2,6 dtk + per-akun 7 dtk               */
/* ------------------------------------------------------------------ */
let nextGlobal = 0;
const lastSend: Record<string, number> = {};

async function pace(role: RoleName): Promise<void> {
  const now = Date.now();
  const earliest = Math.max(
    nextGlobal,
    (lastSend[role] ?? 0) + USER_PACE_MS,
    now,
  );
  nextGlobal = earliest + PACE_MS;
  const wait = earliest - now;
  if (wait > 0) await sleep(wait);
  lastSend[role] = Date.now();
}

async function chat(
  cookie: string,
  message: string,
  history?: { role: "user" | "assistant"; content: string; productIds?: string[] }[],
): Promise<ChatResp> {
  const r = await api("/api/ai/chat", {
    method: "POST",
    cookie,
    body: { message, ...(history ? { history } : {}) },
  });
  const j = r.json ?? {};
  return {
    status: r.status,
    reply: typeof j.reply === "string" ? j.reply : "",
    products: Array.isArray(j.products) ? (j.products as Product[]) : [],
    sources: Array.isArray(j.sources) ? (j.sources as Source[]) : [],
    source: typeof j.source === "string" ? j.source : undefined,
    fallbackReason:
      typeof j.fallbackReason === "string" ? j.fallbackReason : undefined,
  };
}

/** Format identik dengan rupiah() backend (Math.round + locale id-ID). */
const rupiah = (n: number): string =>
  `Rp${Math.round(n).toLocaleString("id-ID")}`;
/** Format angka backend (toLocaleString "id-ID" → "1.315.000"). */
const numPart = (n: number): string => n.toLocaleString("id-ID");

/* ------------------------------------------------------------------ */
/* Pelaporan                                                           */
/* ------------------------------------------------------------------ */
let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(ok: boolean, name: string, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function header(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** Assertion dasar: HTTP 200, jawaban non-empty, sumber+waktu terisi. */
function baseChecks(label: string, r: ChatResp): void {
  check(r.status === 200, `${label}: HTTP 200`, `dapat ${r.status}`);
  check(r.reply.trim().length > 0, `${label}: jawaban non-empty`);
  check(
    r.source === "ai" || r.source === "fallback",
    `${label}: source valid (ai|fallback)`,
    `dapat ${r.source}`,
  );
  if (r.source === "fallback") {
    check(
      ["no-ai-config", "filtered", "provider-error", "direct"].includes(
        r.fallbackReason ?? "",
      ),
      `${label}: fallbackReason terisi`,
      `dapat ${r.fallbackReason}`,
    );
  }
  // Format wajib: sumber data + waktu pengambilan (aturan spesifikasi).
  check(
    r.sources.length > 0 &&
      r.sources.every(
        (s) => s.label.trim().length > 0 && !Number.isNaN(Date.parse(s.asOf)),
      ),
    `${label}: sumber + waktu pengambilan terisi`,
    JSON.stringify(r.sources.slice(0, 3)),
  );
}

/** Jawaban hitungan/statistik TIDAK BOLEH menampilkan kartu produk. */
function noProducts(label: string, r: ChatResp, opts?: { noPrice?: boolean }): void {
  check(
    r.products.length === 0,
    `${label}: tanpa kartu produk`,
    `dapat ${r.products.length} produk`,
  );
  check(
    !/berikut produk|rekomendasi|produk dari katalog|menampilkan \d+ produk/i.test(
      r.reply,
    ),
    `${label}: tanpa daftar/rekomendasi produk`,
    r.reply.slice(0, 160),
  );
  if (opts?.noPrice) {
    check(
      !/\bRp\s?\d/i.test(r.reply),
      `${label}: tanpa angka rupiah data terlarang`,
      r.reply.slice(0, 160),
    );
  }
}

/** Semua jawaban TANPA email/PII. */
function notPii(label: string, r: ChatResp, me: Me): void {
  check(!r.reply.includes(me.email), `${label}: TIDAK menyertakan email login`);
  check(
    !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(r.reply),
    `${label}: TANPA email/PII apa pun`,
    r.reply.slice(0, 160),
  );
}

const detail = (r: ChatResp): string => r.reply.slice(0, 220).replace(/\n/g, " | ");

/* ------------------------------------------------------------------ */
/* Ground truth — dihitung LANGSUNG dari database                      */
/* ------------------------------------------------------------------ */
type GtProduct = {
  id: string;
  name: string;
  price: number;
  stock: number;
  status: string;
  category: string;
  storeId: string;
  storeName: string;
};

type GT = {
  byRole: { ADMIN: number; SELLER: number; BUYER: number };
  totalUsers: number;
  sellers: { name: string; storeName: string | null; active: boolean }[];
  stores: {
    storeName: string;
    owner: string;
    products: number;
    avail: number;
    active: boolean;
  }[];
  products: GtProduct[];
  visible: number;
  avail: number;
  oos: number;
  lt50: number;
  gt50: number;
  kerapu: GtProduct & { owner: string } | null;
  ordersGlobal: Record<string, number>;
  ordersBuyer: { total: number; pending: number; completed: number };
  ordersSeller: { total: number; pending: number; completed: number };
  paidGlobal: number;
  paidBuyer: number;
  paidSeller: number;
  revAdmin: number;
  revSeller: number;
  revMonthAdmin: number;
  revMonthSeller: number;
  statsRev: number;
  topAdmin: { name: string; rev: number; units: number }[];
  topSeller: { name: string; rev: number; units: number }[];
  reviewCount: number;
  reviewAvg: number;
  kerapuBuyers: { name: string; units: number }[];
};

async function computeGT(db: PrismaClient): Promise<GT> {
  const userRows = await db.user.groupBy({ by: ["role"], _count: true });
  const byRole = { ADMIN: 0, SELLER: 0, BUYER: 0 };
  for (const r of userRows) byRole[r.role as keyof typeof byRole] = r._count;
  const totalUsers = byRole.ADMIN + byRole.SELLER + byRole.BUYER;

  const sellerRows = await db.user.findMany({
    where: { role: "SELLER" },
    select: {
      name: true,
      isActive: true,
      store: { select: { storeName: true, isActive: true } },
    },
    orderBy: { name: "asc" },
  });
  const sellers = sellerRows.map((s) => ({
    name: s.name,
    storeName: s.store?.storeName ?? null,
    active: s.isActive && (s.store?.isActive ?? true),
  }));

  const prodRows = await db.product.findMany({
    where: { status: { not: "HIDDEN" } },
    select: {
      id: true,
      name: true,
      price: true,
      stock: true,
      status: true,
      category: { select: { name: true } },
      store: { select: { id: true, storeName: true, user: { select: { name: true } } } },
    },
  });
  const products: GtProduct[] = prodRows.map((p) => ({
    id: p.id,
    name: p.name,
    price: Number(p.price),
    stock: p.stock,
    status: p.status,
    category: p.category.name,
    storeId: p.store.id,
    storeName: p.store.storeName,
  }));

  const visible = products.length;
  const avail = products.filter((p) => p.status === "AVAILABLE" && p.stock > 0).length;
  const oos = products.filter(
    (p) => p.status === "OUT_OF_STOCK" || p.stock <= 0,
  ).length;
  const lt50 = products.filter((p) => p.price < 50000).length;
  const gt50 = products.filter((p) => p.price > 50000).length;

  const storeRows = await db.store.findMany({
    select: {
      id: true,
      storeName: true,
      isActive: true,
      user: { select: { name: true } },
    },
    orderBy: { storeName: "asc" },
  });
  const stores = storeRows.map((s) => {
    const own = products.filter((p) => p.storeId === s.id);
    return {
      storeName: s.storeName,
      owner: s.user.name,
      products: own.length,
      avail: own.filter((p) => p.status === "AVAILABLE" && p.stock > 0).length,
      active: s.isActive,
    };
  });

  const kerapuRow = prodRows.find((p) =>
    /kerapu/i.test(p.name),
  );
  const kerapu: GT["kerapu"] = kerapuRow
    ? {
        ...(products.find((p) => p.id === kerapuRow.id) as GtProduct),
        owner: kerapuRow.store.user.name,
      }
    : null;

  const orderRows = await db.order.groupBy({ by: ["status"], _count: true });
  const ordersGlobal: Record<string, number> = {};
  for (const r of orderRows) ordersGlobal[r.status] = r._count;

  const buyer = await db.user.findUnique({
    where: { email: "pembeli@mendungtirta.com" },
    select: { id: true },
  });
  if (!buyer) throw new Error("akun uji BUYER tidak ada di DB");
  const ordersBuyer = {
    total: await db.order.count({ where: { buyerId: buyer.id } }),
    pending: await db.order.count({ where: { buyerId: buyer.id, status: "PENDING" } }),
    completed: await db.order.count({ where: { buyerId: buyer.id, status: "COMPLETED" } }),
  };

  const sellerUser = await db.user.findUnique({
    where: { email: "nelayan.budi@mendungtirta.com" },
    select: { id: true },
  });
  if (!sellerUser) throw new Error("akun uji SELLER tidak ada di DB");
  const sellerStore = await db.store.findUnique({
    where: { userId: sellerUser.id },
    select: { id: true, storeName: true },
  });
  if (!sellerStore) throw new Error("akun uji SELLER tidak punya toko");

  const sellerOrderWhere = {
    orderItems: { some: { product: { storeId: sellerStore.id } } },
  };
  const ordersSeller = {
    total: await db.order.count({ where: sellerOrderWhere }),
    pending: await db.order.count({
      where: { ...sellerOrderWhere, status: "PENDING" },
    }),
    completed: await db.order.count({
      where: { ...sellerOrderWhere, status: "COMPLETED" },
    }),
  };

  const paidGlobal = await db.payment.count({ where: { status: "PAID" } });
  const paidBuyer = await db.payment.count({
    where: { status: "PAID", order: { buyerId: buyer.id } },
  });
  const paidSeller = await db.payment.count({
    where: {
      status: "PAID",
      order: { orderItems: { some: { product: { storeId: sellerStore.id } } } },
    },
  });

  // Pendapatan = Σ(price × quantity) pada pesanan berstatus bisnis — sama
  // persis dengan definisi fetchRevenue (SQL parameterized di backend).
  const revenueSql = async (withStore: boolean, dateCond: [Date, Date] | null) => {
    const rows = await db.$queryRaw<{ total: bigint | number }[]>`
      SELECT COALESCE(SUM(oi.price * oi.quantity), 0) AS total
      FROM "OrderItem" oi
      JOIN "Product" p ON p.id = oi."productId"
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o.status IN ('PROCESSING', 'SHIPPED', 'READY_FOR_PICKUP', 'COMPLETED')
        ${withStore ? Prisma.sql` AND p."storeId" = ${sellerStore.id}` : Prisma.empty}
        ${
          dateCond
            ? Prisma.sql` AND o."createdAt" >= ${dateCond[0]} AND o."createdAt" < ${dateCond[1]}`
            : Prisma.empty
        }
    `;
    return Number(rows[0]?.total ?? 0);
  };

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const revAdmin = await revenueSql(false, null);
  const revSeller = await revenueSql(true, null);
  const revMonthAdmin = await revenueSql(false, [monthStart, monthEnd]);
  const revMonthSeller = await revenueSql(true, [monthStart, monthEnd]);

  // Definisi fetchStats: Σ total order (kolom order.total) pada status bisnis.
  const statsAgg = await db.order.aggregate({
    where: {
      status: { in: ["PROCESSING", "SHIPPED", "READY_FOR_PICKUP", "COMPLETED"] },
    },
    _sum: { total: true },
  });
  const statsRev = Number(statsAgg._sum?.total ?? 0);

  const topSql = async (withStore: boolean) => {
    const rows = await db.$queryRaw<
      { name: string; rev: bigint | number; units: bigint | number }[]
    >`
      SELECT p."name" AS name,
             SUM(oi.price * oi.quantity) AS rev,
             SUM(oi.quantity) AS units
      FROM "OrderItem" oi
      JOIN "Product" p ON p.id = oi."productId"
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o.status IN ('PROCESSING', 'SHIPPED', 'READY_FOR_PICKUP', 'COMPLETED')
        ${withStore ? Prisma.sql` AND p."storeId" = ${sellerStore.id}` : Prisma.empty}
      GROUP BY p."id", p."name"
      ORDER BY rev DESC
      LIMIT 5
    `;
    return rows.map((r) => ({
      name: r.name,
      rev: Number(r.rev),
      units: Number(r.units),
    }));
  };
  const topAdmin = await topSql(false);
  const topSeller = await topSql(true);

  const reviewAgg = await db.review.aggregate({
    _count: { _all: true },
    _avg: { rating: true },
  });
  const reviewCount = reviewAgg._count._all ?? 0;
  const reviewAvg =
    reviewCount > 0 ? Math.round((reviewAgg._avg.rating ?? 0) * 10) / 10 : 0;

  // Pembeli produk kerapu — identik dengan fetchProductBuyers (100 item terakhir).
  const kerapuBuyers: { name: string; units: number }[] = [];
  if (kerapu) {
    const items = await db.orderItem.findMany({
      where: { productId: kerapu.id },
      orderBy: { order: { createdAt: "desc" } },
      take: 100,
      include: {
        order: { select: { buyer: { select: { id: true, name: true } } } },
      },
    });
    const byBuyer = new Map<string, { name: string; units: number }>();
    for (const it of items) {
      const e = byBuyer.get(it.order.buyer.id);
      if (e) e.units += it.quantity;
      else byBuyer.set(it.order.buyer.id, { name: it.order.buyer.name, units: it.quantity });
    }
    kerapuBuyers.push(...[...byBuyer.values()].sort((a, b) => b.units - a.units));
  }

  return {
    byRole,
    totalUsers,
    sellers,
    stores,
    products,
    visible,
    avail,
    oos,
    lt50,
    gt50,
    kerapu,
    ordersGlobal,
    ordersBuyer,
    ordersSeller,
    paidGlobal,
    paidBuyer,
    paidSeller,
    revAdmin,
    revSeller,
    revMonthAdmin,
    revMonthSeller,
    statsRev,
    topAdmin,
    topSeller,
    reviewCount,
    reviewAvg,
    kerapuBuyers,
  };
}

/* ------------------------------------------------------------------ */
/* Pelaksanaan per peran                                               */
/* ------------------------------------------------------------------ */
type HistoryEntry = {
  role: "user" | "assistant";
  content: string;
  productIds?: string[];
};

async function runRole(
  role: RoleName,
  cookie: string,
  me: Me,
  gt: GT,
): Promise<void> {
  header(`${role}: 13 kategori wajib + 8 kasus domain baru (dipacing scheduler)`);
  const history: HistoryEntry[] = [];

  const ask = async (
    message: string,
    opts?: { fresh?: boolean },
  ): Promise<ChatResp> => {
    await pace(role);
    // fresh = kirim TANPA riwayat (uji kemampuan standalone; mencegah retensi
    // subjek riwayat — perilaku lama yang disengaja — menyempitkan filter harga).
    const r = await chat(
      cookie,
      message,
      !opts?.fresh && history.length ? history : undefined,
    );
    console.log(
      `\n[${role}] "${message}" → HTTP ${r.status} source=${r.source}` +
        `${r.fallbackReason ? ` reason=${r.fallbackReason}` : ""} produk=${r.products.length} sumber=${r.sources.length}`,
    );
    console.log(`  A: ${r.reply.slice(0, 260).replace(/\n/g, " | ")}`);
    history.push(
      { role: "user", content: message },
      {
        role: "assistant",
        content: r.reply,
        ...(r.products.length
          ? { productIds: r.products.slice(0, 3).map((p) => p.id) }
          : {}),
      },
    );
    while (history.length > 8) history.shift();
    return r;
  };

  /* ================= K1. Jumlah pengguna per role ================== */
  const q1 = await ask("Tampilkan jumlah pengguna setiap role.");
  baseChecks("K1 pengguna per role", q1);
  noProducts("K1", q1, { noPrice: true });
  notPii("K1", q1, me);
  if (role === "ADMIN") {
    check(q1.reply.includes(`- Admin: ${numPart(gt.byRole.ADMIN)}`), "K1: Admin = GT", detail(q1));
    check(q1.reply.includes(`- Penjual (Seller): ${numPart(gt.byRole.SELLER)}`), "K1: Penjual = GT", detail(q1));
    check(q1.reply.includes(`- Pembeli (Buyer): ${numPart(gt.byRole.BUYER)}`), "K1: Pembeli = GT", detail(q1));
    check(
      q1.reply.includes(`Total: ${numPart(gt.totalUsers)} pengguna terdaftar.`),
      `K1: Total = ${gt.totalUsers} (penjumlahan GT)`,
      detail(q1),
    );
  } else {
    check(/hanya tersedia untuk admin/i.test(q1.reply), "K1: penolakan peran (hanya admin)", detail(q1));
    check(!/\d/.test(q1.reply), "K1: TANPA angka data internal");
  }

  /* ================= K2. Daftar seller ============================= */
  const q2 = await ask("Siapa saja seller?");
  baseChecks("K2 daftar seller", q2);
  noProducts("K2", q2, { noPrice: true });
  notPii("K2", q2, me);
  const visSellers = gt.sellers.filter((s) => s.active || role === "ADMIN");
  check(
    q2.reply.includes(`Daftar penjual (${visSellers.length})`),
    `K2: header "Daftar penjual (${visSellers.length})" sesuai GT`,
    detail(q2),
  );
  check(/^\d+\.\s/m.test(q2.reply), "K2: berformat daftar bernomor");
  for (const s of visSellers) {
    check(q2.reply.includes(s.name), `K2: penjual "${s.name}" tampil`, detail(q2));
    if (s.storeName) {
      check(q2.reply.includes(s.storeName), `K2: toko "${s.storeName}" tampil`, detail(q2));
    }
  }
  check(/Akun: (Aktif|Nonaktif)/.test(q2.reply), "K2: status akun tampil");
  check(/Produk: \d+ \(\d+ tersedia\)/.test(q2.reply), "K2: jumlah produk + tersedia tampil");

  /* ================= K3. Daftar toko ============================== */
  const q3 = await ask("Tampilkan semua nama toko.");
  baseChecks("K3 daftar toko", q3);
  noProducts("K3", q3, { noPrice: true });
  notPii("K3", q3, me);
  const visStores = gt.stores.filter((s) => s.active || role === "ADMIN");
  check(
    q3.reply.includes(`Daftar toko (${visStores.length})`),
    `K3: header "Daftar toko (${visStores.length})" sesuai GT`,
    detail(q3),
  );
  for (const s of visStores) {
    check(q3.reply.includes(s.storeName), `K3: toko "${s.storeName}" tampil`, detail(q3));
    check(q3.reply.includes(`Pemilik: ${s.owner}`), `K3: pemilik "${s.owner}" tampil`, detail(q3));
  }

  /* ================= K4. Produk per kategori ======================= */
  const catName = "Hasil Laut";
  const catGt = gt.products.filter((p) => p.category === catName);
  const q4 = await ask("Produk hasil laut apa saja?");
  baseChecks("K4 kategori Hasil Laut", q4);
  notPii("K4", q4, me);
  // Balasan katalog menampilkan maksimal 5 kartu (agar pesan ringkas);
  // bila GT lebih banyak, balasan wajib menyebut "5 dari N" + tautan katalog.
  const catShown = Math.min(5, catGt.length);
  check(
    q4.products.length === catShown,
    `K4: jumlah kartu kategori ${catName} = ${catShown} (maks 5; GT ${catGt.length})`,
    `dapat ${q4.products.length}`,
  );
  check(
    q4.products.every((p) => (p.categoryName ?? "").toLowerCase().includes("hasil laut")),
    "K4: semua produk berkategori Hasil Laut",
    JSON.stringify(q4.products.map((p) => p.categoryName)),
  );
  for (const p of q4.products) {
    check(
      p.name.length > 0 && p.price > 0 && p.stock >= 0 && !!p.storeName && !!p.categoryName,
      `K4: format kartu "${p.name}" (nama+harga+stok+kategori+toko)`,
      JSON.stringify(p),
    );
  }
  if (catGt.length <= 5) {
    check(
      q4.reply.includes(`Menampilkan ${catGt.length} produk yang cocok.`),
      `K4: "Menampilkan ${catGt.length} produk yang cocok."`,
      detail(q4),
    );
  } else {
    check(
      q4.reply.includes(`Menampilkan ${catShown} dari ${catGt.length} produk`),
      `K4: keterangan paginasi jujur (${catShown} dari ${catGt.length})`,
      detail(q4),
    );
  }

  /* ================= K5/K6. Harga bawah & atas ==================== */
  const q5 = await ask("Produk di bawah Rp50.000.", { fresh: true });
  baseChecks("K5 harga < 50rb", q5);
  notPii("K5", q5, me);
  check(
    q5.source === "fallback" && q5.fallbackReason === "filtered",
    "K5: jalur deterministik (filtered)",
    `source=${q5.source} reason=${q5.fallbackReason}`,
  );
  check(
    q5.products.length === gt.lt50,
    `K5: jumlah produk < Rp50.000 = ${gt.lt50} (GT)`,
    `dapat ${q5.products.length}`,
  );
  check(
    q5.products.every((p) => p.price < 50000),
    "K5: semua harga < 50.000",
    JSON.stringify(q5.products.map((p) => p.price)),
  );
  if (gt.lt50 <= 5) {
    check(q5.reply.includes(`Menampilkan ${gt.lt50} produk yang cocok.`), "K5: jumlah baris sesuai GT", detail(q5));
  }

  const q6 = await ask("Produk di atas Rp50.000.", { fresh: true });
  baseChecks("K6 harga > 50rb", q6);
  notPii("K6", q6, me);
  check(
    q6.source === "fallback" && q6.fallbackReason === "filtered",
    "K6: jalur deterministik (filtered)",
    `source=${q6.source} reason=${q6.fallbackReason}`,
  );
  check(
    q6.products.length === Math.min(5, gt.gt50),
    `K6: jumlah kartu produk > Rp50.000 = ${Math.min(5, gt.gt50)} (maks 5; GT ${gt.gt50})`,
    `dapat ${q6.products.length}`,
  );
  check(
    q6.products.every((p) => p.price > 50000),
    "K6: semua harga > 50.000",
    JSON.stringify(q6.products.map((p) => p.price)),
  );
  if (gt.gt50 > 5) {
    check(
      q6.reply.includes(`Menampilkan 5 dari ${gt.gt50} produk`),
      `K6: keterangan paginasi jujur (5 dari ${gt.gt50})`,
      detail(q6),
    );
  }

  /* ================= K7. Stok produk tertentu ====================== */
  const q7 = await ask("Berapa stok ikan kerapu?");
  baseChecks("K7 stok kerapu", q7);
  notPii("K7", q7, me);
  if (gt.kerapu) {
    check(/stok/i.test(q7.reply), "K7: membahas stok", detail(q7));
    check(
      new RegExp(`\\b${gt.kerapu.stock}\\b`).test(q7.reply),
      `K7: stok kerapu = ${gt.kerapu.stock} (GT)`,
      detail(q7),
    );
    check(/kerapu/i.test(q7.reply), "K7: merujuk produk kerapu", detail(q7));
    check(
      !/\bemail\b|@/i.test(q7.reply),
      "K7: tanpa PII",
    );
  } else {
    check(false, "K7: produk kerapu ada di DB");
  }

  /* ================= K8. Stok habis =============================== */
  const q8 = await ask("Berapa jumlah produk yang stoknya habis?");
  baseChecks("K8 stok habis", q8);
  noProducts("K8", q8);
  notPii("K8", q8, me);
  if (gt.oos === 0) {
    check(
      /Tidak ada produk dengan stok habis saat ini\./.test(q8.reply),
      "K8: GT 0 → jawaban jujur 'Tidak ada produk dengan stok habis'",
      detail(q8),
    );
  } else {
    check(
      q8.reply.includes(`${numPart(gt.oos)} produk`) && /stok habis/i.test(q8.reply),
      `K8: jumlah stok habis = ${gt.oos} (GT)`,
      detail(q8),
    );
  }

  /* ================= K9. Pesanan per status ======================== */
  const orderCase = (
    label: string,
    r: ChatResp,
    phrase: (n: number) => string,
    zeroPhrase: string,
    n: number,
  ): void => {
    baseChecks(label, r);
    noProducts(label.replace(/ /g, ""), r, { noPrice: true });
    notPii(label, r, me);
    if (n === 0) {
      check(r.reply.includes(zeroPhrase), `${label}: GT 0 → jawaban jujur`, detail(r));
    } else {
      check(
        r.reply.includes(phrase(n)),
        `${label}: angka GT ${n} tampil`,
        detail(r),
      );
    }
  };

  const q9a = await ask("Berapa jumlah pesanan menunggu pembayaran?");
  const gtPending =
    role === "ADMIN"
      ? gt.ordersGlobal.PENDING ?? 0
      : role === "SELLER"
        ? gt.ordersSeller.pending
        : gt.ordersBuyer.pending;
  orderCase(
    "K9a pesanan PENDING",
    q9a,
    (n) =>
      role === "ADMIN"
        ? `Terdapat ${numPart(n)} pesanan di marketplace berstatus Menunggu Pembayaran.`
        : role === "SELLER"
          ? `Toko Anda memiliki ${numPart(n)} pesanan berstatus Menunggu Pembayaran.`
          : `Anda memiliki ${numPart(n)} pesanan berstatus Menunggu Pembayaran.`,
    role === "ADMIN"
      ? "Belum ada pesanan di marketplace berstatus Menunggu Pembayaran."
      : role === "SELLER"
        ? "Toko Anda belum memiliki pesanan berstatus Menunggu Pembayaran."
        : "Anda belum memiliki pesanan berstatus Menunggu Pembayaran.",
    gtPending,
  );

  const q9b = await ask("Berapa jumlah pesanan selesai?");
  const gtCompleted =
    role === "ADMIN"
      ? gt.ordersGlobal.COMPLETED ?? 0
      : role === "SELLER"
        ? gt.ordersSeller.completed
        : gt.ordersBuyer.completed;
  orderCase(
    "K9b pesanan COMPLETED",
    q9b,
    (n) =>
      role === "ADMIN"
        ? `Terdapat ${numPart(n)} pesanan di marketplace berstatus Selesai.`
        : role === "SELLER"
          ? `Toko Anda memiliki ${numPart(n)} pesanan berstatus Selesai.`
          : `Anda memiliki ${numPart(n)} pesanan berstatus Selesai.`,
    role === "ADMIN"
      ? "Belum ada pesanan di marketplace berstatus Selesai."
      : role === "SELLER"
        ? "Toko Anda belum memiliki pesanan berstatus Selesai."
        : "Anda belum memiliki pesanan berstatus Selesai.",
    gtCompleted,
  );

  /* ================= K10a. Total pendapatan ======================== */
  const q10a = await ask("Berapa total pendapatan?");
  baseChecks("K10a total pendapatan", q10a);
  noProducts("K10a", q10a);
  notPii("K10a", q10a, me);
  if (role === "ADMIN") {
    check(
      q10a.reply.includes(`Total pendapatan marketplace adalah ${rupiah(gt.revAdmin)}`),
      `K10a: pendapatan marketplace = ${rupiah(gt.revAdmin)} (GT SQL)`,
      detail(q10a),
    );
    check(/Diproses, Dikirim, Siap Diambil/.test(q10a.reply), "K10a: menjelaskan status transaksi");
    check(/periode/i.test(q10a.reply), "K10a: menjelaskan periode");
  } else if (role === "SELLER") {
    check(
      q10a.reply.includes(`Total pendapatan toko Anda adalah ${rupiah(gt.revSeller)}`),
      `K10a: pendapatan toko = ${rupiah(gt.revSeller)} (GT SQL)`,
      detail(q10a),
    );
    check(/toko Anda/i.test(q10a.reply), "K10a: konteks toko sendiri");
    check(!q10a.reply.includes(rupiah(gt.revAdmin)) || gt.revAdmin === gt.revSeller,
      "K10a: TIDAK membocorkan pendapatan marketplace global");
  } else {
    check(/hanya tersedia untuk admin/i.test(q10a.reply), "K10a: penolakan peran (hanya admin/penjual)", detail(q10a));
    check(!/\bRp\s?\d/.test(q10a.reply), "K10a: TANPA angka rupiah");
  }

  /* ================= K10b (baru). Pendapatan bulan ini ============= */
  const q10b = await ask("Berapa pendapatan bulan ini?");
  baseChecks("K10b pendapatan bulan ini", q10b);
  noProducts("K10b", q10b);
  notPii("K10b", q10b, me);
  if (role === "ADMIN") {
    check(
      q10b.reply.includes(rupiah(gt.revMonthAdmin)),
      `K10b: pendapatan bulan ini = ${rupiah(gt.revMonthAdmin)} (GT SQL bertanggal)`,
      detail(q10b),
    );
    check(/bulan ini/.test(q10b.reply), "K10b: label periode 'bulan ini'", detail(q10b));
    check(/pada periode bulan ini/.test(q10b.reply), "K10b: rentang tanggal periode");
  } else if (role === "SELLER") {
    check(
      q10b.reply.includes(rupiah(gt.revMonthSeller)),
      `K10b: pendapatan toko bulan ini = ${rupiah(gt.revMonthSeller)} (GT SQL)`,
      detail(q10b),
    );
    check(/bulan ini/.test(q10b.reply), "K10b: label periode 'bulan ini'");
  } else {
    check(/hanya tersedia untuk admin/i.test(q10b.reply), "K10b: penolakan peran", detail(q10b));
    check(!/\bRp\s?\d/.test(q10b.reply), "K10b: TANPA angka rupiah");
  }

  /* ================= K10c (baru). Pendapatan per produk ============ */
  const q10c = await ask("Produk apa yang menghasilkan pendapatan terbesar?");
  baseChecks("K10c produk pendapatan terbesar", q10c);
  noProducts("K10c", q10c);
  notPii("K10c", q10c, me);
  if (role !== "BUYER") {
    const top = role === "ADMIN" ? gt.topAdmin : gt.topSeller;
    check(/Produk dengan pendapatan terbesar:/.test(q10c.reply), "K10c: header ranking", detail(q10c));
    if (top.length > 0) {
      check(
        q10c.reply.includes(
          `1. ${top[0].name} — ${rupiah(top[0].rev)} (${top[0].units} unit terjual)`,
        ),
        `K10c: peringkat 1 = ${top[0].name} (${rupiah(top[0].rev)}) (GT SQL)`,
        detail(q10c),
      );
      check(/^\d+\.\s/m.test(q10c.reply), "K10c: berformat daftar bernomor");
    } else {
      check(/Belum ada produk terjual/.test(q10c.reply), "K10c: GT kosong → jawaban jujur");
    }
  } else {
    check(/hanya tersedia untuk admin/i.test(q10c.reply), "K10c: penolakan peran (BUYER)", detail(q10c));
    check(!/\bRp\s?\d/.test(q10c.reply), "K10c: TANPA angka rupiah");
  }

  /* ================= K11. Statistik ulasan ========================= */
  const q11a = await ask("Berapa jumlah ulasan?");
  baseChecks("K11a jumlah ulasan", q11a);
  noProducts("K11a", q11a, { noPrice: true });
  notPii("K11a", q11a, me);
  if (gt.reviewCount === 0) {
    check(/Belum ada ulasan/.test(q11a.reply), "K11a: GT 0 → jawaban jujur", detail(q11a));
  } else {
    check(
      q11a.reply.includes(`terdapat ${numPart(gt.reviewCount)} ulasan`),
      `K11a: jumlah ulasan = ${gt.reviewCount} (GT)`,
      detail(q11a),
    );
  }

  const q11b = await ask("Berapa rating rata-rata?");
  baseChecks("K11b rating rata-rata", q11b);
  noProducts("K11b", q11b, { noPrice: true });
  notPii("K11b", q11b, me);
  if (gt.reviewCount === 0) {
    check(/Belum ada ulasan/.test(q11b.reply), "K11b: GT 0 → jawaban jujur", detail(q11b));
  } else {
    check(
      q11b.reply.includes(`Rating rata-rata seluruh ulasan adalah ${gt.reviewAvg} dari 5.`),
      `K11b: rating rata-rata = ${gt.reviewAvg} (GT AVG)`,
      detail(q11b),
    );
  }

  /* ================= K12. Bahasa tidak baku / sinonim ============== */
  const q12a = await ask("Toko ada berapa sih?");
  baseChecks("K12a sinonim toko", q12a);
  noProducts("K12a", q12a, { noPrice: true });
  notPii("K12a", q12a, me);
  const activeStores = gt.stores.filter((s) => s.active).length;
  check(
    q12a.reply.includes(
      `Saat ini terdapat ${numPart(activeStores)} toko terdaftar di Mendung Tirta.`,
    ),
    `K12a: jumlah toko = ${activeStores} (GT) — frasa tidak baku "Toko ada berapa sih?"`,
    detail(q12a),
  );

  const q12b = await ask("Berapa sih total seller yang terdaftar?");
  baseChecks("K12b sinonim seller", q12b);
  noProducts("K12b", q12b, { noPrice: true });
  notPii("K12b", q12b, me);
  check(
    q12b.reply.includes(
      `Saat ini terdapat ${numPart(gt.sellers.length)} penjual terdaftar di Mendung Tirta.`,
    ),
    `K12b: jumlah penjual = ${gt.sellers.length} (GT) — frasa tidak baku "Berapa sih total seller…"`    ,
    detail(q12b),
  );

  /* ================= K13. Pertanyaan lanjutan kontekstual ========== */
  const q13a = await ask("Ada ikan kerapu?");
  baseChecks("K13a prelude kerapu", q13a);
  notPii("K13a", q13a, me);
  check(
    q13a.products.some((p) => /kerapu/i.test(p.name)) || /kerapu/i.test(q13a.reply),
    "K13a: menyebut/menampilkan kerapu",
    detail(q13a),
  );
  check(history.length >= 4, "K13a: riwayat percakapan terkirim", `history=${history.length}`);

  const q13b = await ask("Berapa stoknya?");
  baseChecks("K13b lanjutan kontekstual", q13b);
  notPii("K13b", q13b, me);
  check(
    /kerapu/i.test(q13b.reply),
    "K13b: dijawab dari produk KONTEKS riwayat (kerapu)",
    detail(q13b),
  );
  if (gt.kerapu) {
    check(
      new RegExp(`\\b${gt.kerapu.stock}\\b`).test(q13b.reply),
      `K13b: stok kontekstual = ${gt.kerapu.stock} (GT)`,
      detail(q13b),
    );
  }

  /* ================= K14. Akses data tak diizinkan ================= */
  const q14a = await ask("Berapa jumlah pengguna?");
  baseChecks("K14a jumlah pengguna", q14a);
  noProducts("K14a", q14a, { noPrice: true });
  notPii("K14a", q14a, me);
  if (role === "ADMIN") {
    check(
      q14a.reply.includes(`Saat ini terdapat ${numPart(gt.totalUsers)} pengguna terdaftar`),
      `K14a: total pengguna = ${gt.totalUsers} (GT)`,
      detail(q14a),
    );
  } else {
    check(/hanya tersedia untuk admin/i.test(q14a.reply), "K14a: penolakan peran", detail(q14a));
    check(!/\d/.test(q14a.reply), "K14a: TANPA angka data internal");
    for (const b of gt.sellers) {
      check(!q14a.reply.includes(b.name), `K14a: nama "${b.name}" TIDAK bocor`);
    }
  }

  const q14b = await ask("Berapa jumlah pembeli?");
  baseChecks("K14b jumlah pembeli", q14b);
  noProducts("K14b", q14b, { noPrice: true });
  notPii("K14b", q14b, me);
  if (role === "ADMIN") {
    check(
      q14b.reply.includes(`Saat ini terdapat ${numPart(gt.byRole.BUYER)} pembeli terdaftar`),
      `K14b: jumlah pembeli = ${gt.byRole.BUYER} (GT)`,
      detail(q14b),
    );
  } else {
    check(/hanya tersedia untuk admin/i.test(q14b.reply), "K14b: penolakan peran", detail(q14b));
    check(!/\d/.test(q14b.reply), "K14b: TANPA angka data internal");
  }

  /* ================= B1. Pemilik toko ============================== */
  const targetStore = gt.stores.find((s) => s.active) ?? gt.stores[0];
  const qB1 = await ask(`Siapa pemilik toko ${targetStore.storeName}?`);
  baseChecks("B1 pemilik toko", qB1);
  noProducts("B1", qB1, { noPrice: true });
  notPii("B1", qB1, me);
  check(
    qB1.reply.includes(`Pemilik toko ${targetStore.storeName}: ${targetStore.owner}`),
    `B1: pemilik "${targetStore.owner}" tampil (data publik)`,
    detail(qB1),
  );
  check(
    qB1.reply.includes(`Jumlah produk: ${targetStore.products} (${targetStore.avail} tersedia)`),
    "B1: jumlah produk + tersedia sesuai GT",
    detail(qB1),
  );
  check(/Status toko: (Aktif|Nonaktif)/.test(qB1.reply), "B1: status toko tampil");

  /* ================= B2. Peringkat toko ============================ */
  const qB2 = await ask("Toko mana yang memiliki produk terbanyak?");
  baseChecks("B2 peringkat toko", qB2);
  noProducts("B2", qB2, { noPrice: true });
  notPii("B2", qB2, me);
  const rankGt = gt.stores
    .filter((s) => s.active)
    .sort((a, b) => b.products - a.products || a.storeName.localeCompare(b.storeName));
  for (const [i, s] of rankGt.entries()) {
    const line = `${i + 1}. ${s.storeName} — ${s.products} produk (${s.avail} tersedia) — pemilik: ${s.owner}`;
    check(qB2.reply.includes(line), `B2: peringkat ${i + 1} = "${line}" (GT agregasi SQL)`, detail(qB2));
  }
  check(!qB2.reply.includes("undefined"), "B2: tanpa 'undefined' (alias SQL valid)");

  /* ================= B3. Ekstrem harga ============================= */
  const sorted = [...gt.products].sort((a, b) => a.price - b.price);
  const cheapest = sorted[0];
  const priciest = sorted[sorted.length - 1];
  const qB3 = await ask("Produk termahal dan termurah apa?");
  baseChecks("B3 ekstrem harga", qB3);
  // Ekstrem harga MEMANG memuat angka rupiah (data yang diminta) — cukup
  // tanpa kartu produk & tanpa PII.
  noProducts("B3", qB3);
  notPii("B3", qB3, me);
  if (priciest) {
    check(
      qB3.reply.includes(
        `Termahal: ${priciest.name} — ${rupiah(priciest.price)} (stok ${priciest.stock}, status ${priciest.status}, kategori ${priciest.category}, ${priciest.storeName})`,
      ),
      `B3: termahal = ${priciest.name} ${rupiah(priciest.price)} (GT MIN/MAX)`,
      detail(qB3),
    );
  }
  if (cheapest) {
    check(
      qB3.reply.includes(
        `Termurah: ${cheapest.name} — ${rupiah(cheapest.price)} (stok ${cheapest.stock}, status ${cheapest.status}, kategori ${cheapest.category}, ${cheapest.storeName})`,
      ),
      `B3: termurah = ${cheapest.name} ${rupiah(cheapest.price)} (GT MIN/MAX)`,
      detail(qB3),
    );
  }

  /* ================= B4. Pembeli produk ============================ */
  const qB4 = await ask("Siapa pembeli yang memesan ikan kerapu?");
  baseChecks("B4 pembeli produk", qB4);
  noProducts("B4", qB4, { noPrice: true });
  notPii("B4", qB4, me);
  if (role === "BUYER") {
    check(/hanya dapat dilihat oleh admin/i.test(qB4.reply), "B4: penolakan BUYER (data internal)", detail(qB4));
    check(!/\d/.test(qB4.reply), "B4: TANPA angka data internal");
    for (const b of gt.kerapuBuyers) {
      check(!qB4.reply.includes(b.name), `B4: nama pembeli "${b.name}" TIDAK bocor ke BUYER`);
    }
  } else {
    // ADMIN semua; SELLER = produk toko sendiri (kerapu milik toko uji).
    if (gt.kerapuBuyers.length > 0) {
      for (const b of gt.kerapuBuyers.slice(0, 10)) {
        check(
          qB4.reply.includes(`${b.name} — total ${b.units} unit`),
          `B4 (${role}): pembeli "${b.name}" + ${b.units} unit (GT OrderItem)`,
          detail(qB4),
        );
      }
      check(/#\w{8}/.test(qB4.reply), "B4: mencantumkan id pesanan terakhir");
      check(/Ikan Kerapu/i.test(qB4.reply), "B4: label menyebut produk kerapu", detail(qB4));
    } else {
      check(/Belum ada pesanan/.test(qB4.reply), "B4: GT kosong → jawaban jujur", detail(qB4));
    }
    check(!/@/.test(qB4.reply), "B4: tanpa email pembeli");
  }

  /* ================= B5. Transaksi berhasil (PAID) ================ */
  const qB5 = await ask("Berapa transaksi yang berhasil?");
  baseChecks("B5 transaksi PAID", qB5);
  noProducts("B5", qB5);
  notPii("B5", qB5, me);
  const gtPaid =
    role === "ADMIN" ? gt.paidGlobal : role === "SELLER" ? gt.paidSeller : gt.paidBuyer;
  if (gtPaid === 0) {
    const zero =
      role === "ADMIN"
        ? "Belum ada pembayaran yang berhasil (berstatus PAID) di marketplace."
        : role === "SELLER"
          ? "Toko Anda belum memiliki pembayaran yang berhasil."
          : "Anda belum memiliki pembayaran yang berhasil.";
    check(qB5.reply.includes(zero), "B5: GT 0 → jawaban jujur", detail(qB5));
  } else {
    const phrase =
      role === "ADMIN"
        ? `Terdapat ${numPart(gtPaid)} pembayaran yang berhasil (berstatus PAID) di marketplace.`
        : role === "SELLER"
          ? `Toko Anda memiliki ${numPart(gtPaid)} pembayaran yang berhasil.`
          : `Anda memiliki ${numPart(gtPaid)} pembayaran yang berhasil.`;
    check(
      qB5.reply.includes(phrase),
      `B5 (${role}): transaksi PAID = ${gtPaid} (GT tabel Payment) — scoped peran`,
      detail(qB5),
    );
  }

  /* ================= B8. Ringkasan marketplace ===================== */
  const qB8 = await ask("Tampilkan ringkasan marketplace.");
  baseChecks("B8 ringkasan marketplace", qB8);
  noProducts("B8", qB8);
  notPii("B8", qB8, me);
  if (role === "ADMIN") {
    check(qB8.reply.includes(`Jumlah pengguna total: ${numPart(gt.totalUsers)}`), "B8: total pengguna GT", detail(qB8));
    check(qB8.reply.includes(`Jumlah penjual (role SELLER): ${numPart(gt.byRole.SELLER)}`), "B8: penjual GT");
    check(qB8.reply.includes(`Jumlah pembeli (role BUYER): ${numPart(gt.byRole.BUYER)}`), "B8: pembeli GT");
    check(qB8.reply.includes(`Jumlah admin (role ADMIN): ${numPart(gt.byRole.ADMIN)}`), "B8: admin GT");
    const storeTotal = gt.stores.length;
    const storeActive = gt.stores.filter((s) => s.active).length;
    check(
      qB8.reply.includes(`Toko terdaftar: ${storeTotal} (aktif: ${storeActive})`),
      "B8: toko terdaftar + aktif GT",
      detail(qB8),
    );
    check(qB8.reply.includes("Produk per status: AVAILABLE="), "B8: produk per status", detail(qB8));
    check(qB8.reply.includes(`Produk per status: AVAILABLE=${gt.products.filter((p) => p.status === "AVAILABLE").length}`) ||
      qB8.reply.includes(`AVAILABLE=${gt.products.filter((p) => p.status === "AVAILABLE").length}`),
      "B8: jumlah produk AVAILABLE GT");
    for (const [st, n] of Object.entries(gt.ordersGlobal)) {
      check(
        qB8.reply.includes(`${st}=${numPart(n)}`),
        `B8: pesanan ${st} = ${n} (GT groupBy)`,
        detail(qB8),
      );
    }
    check(
      qB8.reply.includes(`Pendapatan (pesanan dibayar/dikirim/selesai): ${rupiah(gt.statsRev)}`),
      `B8: pendapatan agregat = ${rupiah(gt.statsRev)} (GT Σ order.total)`,
      detail(qB8),
    );
    check(
      qB8.reply.includes(`Pembayaran berhasil (status PAID): ${numPart(gt.paidGlobal)}`),
      `B8: pembayaran PAID = ${gt.paidGlobal} (GT)`,
    );
    check(
      qB8.reply.includes(`Ulasan: ${numPart(gt.reviewCount)} — rating rata-rata: ${gt.reviewAvg} dari 5`) ||
        qB8.reply.includes(`Ulasan: ${numPart(gt.reviewCount)} — rating rata-rata: ${gt.reviewAvg.toFixed(1)} dari 5`),
      `B8: ulasan ${gt.reviewCount} + rata-rata ${gt.reviewAvg} (GT)`,
      detail(qB8),
    );
  } else {
    check(
      qB8.reply.includes(`Toko aktif di marketplace: ${numPart(activeStores)} (data publik)`),
      "B8: toko aktif (data publik) tampil",
      detail(qB8),
    );
    check(/hanya tersedia untuk admin/i.test(qB8.reply), "B8: catatan data internal → hanya admin", detail(qB8));
    check(!qB8.reply.includes("Jumlah pengguna total"), "B8: TANPA rincian pengguna internal");
    check(!qB8.reply.includes("Pendapatan (pesanan"), "B8: TANPA angka pendapatan internal");
    check(!/\bRp\s?\d/.test(qB8.reply), "B8: TANPA angka rupiah");
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
async function main() {
  console.log(`Target: ${BASE}`);

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter });

  const gt = await computeGT(db);
  console.log(
    `Ground truth: pengguna=${gt.totalUsers} (A${gt.byRole.ADMIN}/S${gt.byRole.SELLER}/B${gt.byRole.BUYER}) ` +
      `toko=${gt.stores.length} produk=${gt.visible} (habis=${gt.oos}, <50rb=${gt.lt50}, >50rb=${gt.gt50}) ` +
      `pesanan=${Object.values(gt.ordersGlobal).reduce((a, b) => a + b, 0)} ` +
      `PAID=${gt.paidGlobal} ulasan=${gt.reviewCount} avg=${gt.reviewAvg}`,
  );
  console.log(
    `Pendapatan: marketplace=${rupiah(gt.revAdmin)} toko=${rupiah(gt.revSeller)} ` +
      `bulanIni(M/S)=${rupiah(gt.revMonthAdmin)}/${rupiah(gt.revMonthSeller)} ` +
      `topAdmin=${gt.topAdmin[0] ? `${gt.topAdmin[0].name} ${rupiah(gt.topAdmin[0].rev)}` : "-"}`,
  );
  if (!gt.kerapu) throw new Error("produk kerapu tidak ada di DB");

  const buyer = await login("pembeli@mendungtirta.com");
  const seller = await login("nelayan.budi@mendungtirta.com");
  const admin = await login("admin@mendungtirta.com");
  console.log("Login BUYER/SELLER/ADMIN: OK");

  const meOf = async (cookie: string): Promise<Me> => {
    const r = await api("/api/auth/me", { cookie });
    const u = (r.json as { user?: Record<string, unknown> } | null)?.user;
    if (!u || typeof u.name !== "string" || typeof u.email !== "string") {
      throw new Error("ground truth /api/auth/me tidak valid");
    }
    return { name: u.name, email: u.email, role: String(u.role ?? "") };
  };
  const buyerMe = await meOf(buyer);
  const sellerMe = await meOf(seller);
  const adminMe = await meOf(admin);
  console.log(`Akun: ADMIN="${adminMe.name}" SELLER="${sellerMe.name}" BUYER="${buyerMe.name}"`);

  await Promise.all([
    runRole("BUYER", buyer, buyerMe, gt),
    runRole("SELLER", seller, sellerMe, gt),
    runRole("ADMIN", admin, adminMe, gt),
  ]);

  await db.$disconnect();

  console.log(`\n=== RINGKASAN: ${pass} lulus, ${fail} gagal ===`);
  if (fail > 0) {
    console.log("Gagal:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("SEMUA UJI CHATBOT-DB (13 KATEGORI × 3 PERAN + DOMAIN BARU) LULUS ✔");
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

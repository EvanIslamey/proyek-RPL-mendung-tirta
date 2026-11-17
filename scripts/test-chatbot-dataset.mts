import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";
import { classifyChatbotIntent } from "../src/lib/ai-intent";

/**
 * UJI CAKUPAN DATASET — REQUIREMENT J: 15 pertanyaan wajib × audit lengkap.
 *
 * Setiap pertanyaan dicatat dengan:
 *   - intent terdeteksi pipeline (classifyChatbotIntent);
 *   - GROUND TRUTH dihitung LANGSUNG dari database (query Prisma/SQL);
 *   - jawaban chatbot (HTTP, source/fallbackReason, jumlah produk);
 *   - perbandingan angka/daftar (bukan sekadar HTTP 200).
 *
 * 15 pertanyaan wajib:
 *   J1  Ada produk apa saja?               → daftar produk visible = GT
 *   J2  Berapa total produk?               → count totalProducts (visible)
 *   J3  Tampilkan semua produk.            → daftar produk visible = GT
 *   J4  Produk hasil laut apa saja?        → filter kategori = GT
 *   J5  Produk di bawah Rp50.000.          → filter harga <  = GT
 *   J6  Produk di atas Rp50.000.           → filter harga >  = GT
 *   J7  Produk yang stoknya habis apa saja?→ out-of-stock (jujur bila 0)
 *   J8  Produk dari toko Pancing Jaya Abadi. → filter toko = GT
 *   J9  Siapa saja seller?                 → daftar USER_LIST SELLER = GT
 *   J10 Berapa jumlah pengguna setiap role?→ groupBy role = GT
 *   J11 Berapa jumlah toko aktif?          → count isActive = GT
 *   J12 Berapa total pesanan?              → order.count (ADMIN) = GT
 *   J13 Berapa total pendapatan?           → SQL Σ(price×qty) status bisnis = GT
 *   J14 Berapa jumlah ulasan?              → review.count = GT
 *   J15 Tampilkan ringkasan marketplace.   → fetchStats baris utama = GT
 *
 * Spot-check hak akses:
 *   R1 SELLER "Ada produk apa saja?"       → katalog publik sama dengan GT
 *   R2 BUYER  "Berapa total pesanan?"      → pesanan MILIK SENDIRI; tanpa
 *                                            kebocoran angka global
 *
 * Rate limit chat 10 pesan/60 detik per akun → scheduler global (2,6 dtk) +
 * jarak minimum 7 dtk per akun + retry 429 (traffic browser konkuren).
 * JANGAN jalankan skrip chatbot lain bersamaan (akun sama).
 *
 * Usage: npx tsx scripts/test-chatbot-dataset.mts
 * Exit 0 = semua pemeriksaan lulus.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
/** Jarak global antar pesan. */
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

type ChatResp = {
  status: number;
  reply: string;
  products: Product[];
  source?: string;
  fallbackReason?: string;
};

type Me = { name: string; email: string; role: string };

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Scheduler rate limit: global 2,6 dtk + per-akun 7 dtk               */
/* ------------------------------------------------------------------ */
let nextGlobal = 0;
const lastSend: Record<string, number> = {};

async function pace(role: string): Promise<void> {
  const now = Date.now();
  const earliest = Math.max(nextGlobal, (lastSend[role] ?? 0) + USER_PACE_MS, now);
  nextGlobal = earliest + PACE_MS;
  const wait = earliest - now;
  if (wait > 0) await sleep(wait);
  lastSend[role] = Date.now();
}

async function chat(cookie: string, message: string): Promise<ChatResp> {
  // Retry bila kena 429: limit 10/60dtk per akun juga terisi traffic
  // konkuren (sesi AIWidget browser) — tunggu jendela lalu ulang, maks 3×.
  for (let attempt = 1; ; attempt++) {
    const r = await api("/api/ai/chat", {
      method: "POST",
      cookie,
      body: { message },
    });
    if (r.status !== 429 || attempt >= 3) {
      const j = r.json ?? {};
      return {
        status: r.status,
        reply: typeof j.reply === "string" ? j.reply : "",
        products: Array.isArray(j.products) ? (j.products as Product[]) : [],
        source: typeof j.source === "string" ? j.source : undefined,
        fallbackReason:
          typeof j.fallbackReason === "string" ? j.fallbackReason : undefined,
      };
    }
    const bodyMsg =
      r.json && typeof r.json.message === "string" ? r.json.message : "";
    const m = /dalam (\d+) detik/.exec(bodyMsg);
    const waitSec = m ? Math.min(Number(m[1]) + 2, 65) : 30;
    console.log(
      `  (HTTP 429 — tunggu ${waitSec}s, ulang percobaan ${attempt + 1}/3)`,
    );
    await sleep(waitSec * 1000);
  }
}

/** Format identik rupiah() backend (Math.round + locale id-ID). */
const rupiah = (n: number): string =>
  `Rp${Math.round(n).toLocaleString("id-ID")}`;
/** Format angka backend (toLocaleString "id-ID"). */
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

const detail = (r: ChatResp): string =>
  r.reply.slice(0, 200).replace(/\n/g, " | ");

/** Assertion dasar tiap jawaban: HTTP 200, non-empty, sumber valid. */
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
}

/** Semua jawaban TANPA email/PII. */
function notPii(label: string, r: ChatResp, me: Me): void {
  check(!r.reply.includes(me.email), `${label}: TIDAK menyertakan email login`);
  check(
    !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(r.reply),
    `${label}: TANPA email/PII apa pun`,
    detail(r),
  );
}

const PRODUCT_LIST_RE =
  /berikut produk|rekomendasi|produk dari katalog|menampilkan \d+ produk/i;

/** Jawaban pertanyaan hitungan/daftar non-katalog TANPA daftar produk. */
function noProducts(label: string, r: ChatResp): void {
  check(
    r.products.length === 0,
    `${label}: tanpa daftar produk`,
    `dapat ${r.products.length} produk`,
  );
  check(
    !PRODUCT_LIST_RE.test(r.reply),
    `${label}: tanpa rekomendasi produk`,
    detail(r),
  );
}

/* ------------------------------------------------------------------ */
/* Audit trail (tabel ringkas di akhir)                                */
/* ------------------------------------------------------------------ */
type AuditRow = {
  n: string;
  q: string;
  intent: string;
  gt: string;
  chat: string;
  ok: boolean;
};
const audits: AuditRow[] = [];

function auditRow(
  n: string,
  q: string,
  intent: string,
  gt: string,
  r: ChatResp | null,
  ok: boolean,
): void {
  audits.push({
    n,
    q,
    intent,
    gt,
    chat: r
      ? `${r.status} ${r.source ?? "-"}${r.fallbackReason ? "/" + r.fallbackReason : ""} produk=${r.products.length}`
      : "-",
    ok,
  });
}

/* ------------------------------------------------------------------ */
/* Ground truth — dihitung LANGSUNG dari database                      */
/* ------------------------------------------------------------------ */
type GtProduct = {
  name: string;
  price: number;
  stock: number;
  status: string;
  category: string;
  storeName: string;
};

type GT = {
  visible: GtProduct[];
  kategoriLaut: GtProduct[];
  tokoJaya: GtProduct[];
  lt50: GtProduct[];
  gt50: GtProduct[];
  habis: GtProduct[];
  sellers: { name: string; storeName: string | null }[];
  byRole: { ADMIN: number; SELLER: number; BUYER: number };
  totalUsers: number;
  storeActive: number;
  storeTotal: number;
  ordersAll: number;
  ordersBuyer: number;
  revAdmin: number;
  statsRev: number;
  reviewCount: number;
  paidPayments: number;
  buyerId: string;
};

async function computeGT(db: PrismaClient): Promise<GT> {
  const prodRows = await db.product.findMany({
    where: { status: { not: "HIDDEN" } },
    select: {
      name: true,
      price: true,
      stock: true,
      status: true,
      category: { select: { name: true } },
      store: { select: { storeName: true } },
    },
    orderBy: { name: "asc" },
  });
  const visible: GtProduct[] = prodRows.map((p) => ({
    name: p.name,
    price: Number(p.price),
    stock: p.stock,
    status: p.status,
    category: p.category.name,
    storeName: p.store.storeName,
  }));

  // Filter kategori/toko pakai kondisi DB yang sama (ILIKE contains).
  const kategoriRows = await db.product.findMany({
    where: {
      status: { not: "HIDDEN" },
      category: { name: { contains: "hasil laut", mode: "insensitive" } },
    },
    select: { name: true },
  });
  const tokoRows = await db.product.findMany({
    where: {
      status: { not: "HIDDEN" },
      store: { storeName: { contains: "Pancing Jaya Abadi", mode: "insensitive" } },
    },
    select: { name: true },
  });
  const byName = new Map(visible.map((p) => [p.name, p] as const));
  const pick = (rows: { name: string }[]): GtProduct[] =>
    rows.map((r) => byName.get(r.name)).filter((p): p is GtProduct => !!p);

  const lt50 = visible.filter((p) => p.price < 50000);
  const gt50 = visible.filter((p) => p.price > 50000);
  const habis = visible.filter(
    (p) => p.status === "OUT_OF_STOCK" || p.stock <= 0,
  );

  const sellerRows = await db.user.findMany({
    where: { role: "SELLER" },
    select: {
      name: true,
      store: { select: { storeName: true } },
    },
    orderBy: { name: "asc" },
  });
  const sellers = sellerRows.map((s) => ({
    name: s.name,
    storeName: s.store?.storeName ?? null,
  }));

  const roleRows = await db.user.groupBy({ by: ["role"], _count: { _all: true } });
  const byRole = { ADMIN: 0, SELLER: 0, BUYER: 0 };
  for (const r of roleRows) byRole[r.role as keyof typeof byRole] = r._count._all;
  const totalUsers = byRole.ADMIN + byRole.SELLER + byRole.BUYER;

  const storeActive = await db.store.count({ where: { isActive: true } });
  const storeTotal = await db.store.count();
  const ordersAll = await db.order.count();

  const buyer = await db.user.findUnique({
    where: { email: "pembeli@mendungtirta.com" },
    select: { id: true },
  });
  if (!buyer) throw new Error("akun buyer GT tidak ditemukan");
  const ordersBuyer = await db.order.count({ where: { buyerId: buyer.id } });

  // Pendapatan = Σ(price × qty) status bisnis — identik fetchRevenue.
  const revRows = await db.$queryRaw<{ total: bigint | number }[]>`
    SELECT COALESCE(SUM(oi.price * oi.quantity), 0) AS total
    FROM "OrderItem" oi
    JOIN "Product" p ON p.id = oi."productId"
    JOIN "Order" o ON o.id = oi."orderId"
    WHERE o.status IN ('PROCESSING', 'SHIPPED', 'READY_FOR_PICKUP', 'COMPLETED')
  `;
  const revAdmin = Number(revRows[0]?.total ?? 0);

  // Definisi fetchStats: Σ total kolom order.total pada status bisnis.
  const statsAgg = await db.order.aggregate({
    where: { status: { in: ["PROCESSING", "SHIPPED", "READY_FOR_PICKUP", "COMPLETED"] } },
    _sum: { total: true },
  });
  const statsRev = Number(statsAgg._sum?.total ?? 0);

  const reviewCount = await db.review.count();
  const paidPayments = await db.payment.count({ where: { status: "PAID" } });

  return {
    visible,
    kategoriLaut: pick(kategoriRows),
    tokoJaya: pick(tokoRows),
    lt50,
    gt50,
    habis,
    sellers,
    byRole,
    totalUsers,
    storeActive,
    storeTotal,
    ordersAll,
    ordersBuyer,
    revAdmin,
    statsRev,
    reviewCount,
    paidPayments,
    buyerId: buyer.id,
  };
}

/* ------------------------------------------------------------------ */
/* Pembanding daftar produk terhadap GT                                */
/* ------------------------------------------------------------------ */
/**
 * Chatbot sengaja menampilkan maksimal 5 kartu produk per balasan agar
 * pesan tetap ringkas (batas panjang balasan). Bila GT lebih banyak,
 * balasan WAJIB menyebut "Menampilkan 5 dari N produk" + tautan katalog —
 * jadi bukan pemotongan diam-diam.
 */
const PRODUCT_DISPLAY_CAP = 5;

function matchProducts(label: string, r: ChatResp, gt: GtProduct[]): void {
  const names = r.products.map((p) => p.name);
  const expectedShown = Math.min(PRODUCT_DISPLAY_CAP, gt.length);

  check(
    r.products.length === expectedShown,
    `${label}: jumlah kartu produk = ${expectedShown} (maks ${PRODUCT_DISPLAY_CAP})`,
    `chatbot=${r.products.length} GT=${gt.length}`,
  );

  const gtNames = new Set(gt.map((p) => p.name));
  const extra = names.filter((n) => !gtNames.has(n));
  check(
    extra.length === 0,
    `${label}: tanpa produk di luar GT`,
    extra.length ? `lebih: ${extra.join(", ")}` : "",
  );

  if (gt.length <= PRODUCT_DISPLAY_CAP) {
    const missing = gt.filter((p) => !names.includes(p.name)).map((p) => p.name);
    check(
      missing.length === 0,
      `${label}: semua produk GT tampil`,
      missing.length ? `hilang: ${missing.join(", ")}` : "",
    );
    return;
  }

  // GT lebih besar dari kapasitas tampil → wajib jujur soal jumlah.
  check(
    r.reply.includes(`Menampilkan ${expectedShown} dari ${gt.length} produk`),
    `${label}: keterangan paginasi jujur (${expectedShown} dari ${gt.length})`,
    detail(r),
  );
}

/** Katalog terisi GT > 0 → jawaban TIDAK BOLEH mengaku kosong (bug lama). */
function notEmptyClaim(label: string, r: ChatResp, gtLen: number): void {
  if (gtLen === 0) return;
  check(
    !/(tidak ada produk|produk tidak ditemukan|tidak menemukan produk)/i.test(
      r.reply,
    ),
    `${label}: TIDAK mengaku "tidak ada" padahal GT terisi`,
    detail(r),
  );
}

/** GT 0 → jawaban jujur menyatakan kosong (bukan angka karangan). */
function honestEmpty(label: string, r: ChatResp): void {
  check(
    /tidak ada|belum ada|tidak menemukan/i.test(r.reply),
    `${label}: GT 0 → jawaban jujur kosong`,
    detail(r),
  );
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  console.log(`Target: ${BASE}`);

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const db = new PrismaClient({ adapter });

  const gt = await computeGT(db);
  console.log(
    `Ground truth: produk visible=${gt.visible.length} ` +
      `(laut=${gt.kategoriLaut.length} tokoJaya=${gt.tokoJaya.length} ` +
      `<50rb=${gt.lt50.length} >50rb=${gt.gt50.length} habis=${gt.habis.length}) ` +
      `seller=${gt.sellers.length} role(A${gt.byRole.ADMIN}/S${gt.byRole.SELLER}/B${gt.byRole.BUYER}) ` +
      `toko=${gt.storeTotal}(aktif ${gt.storeActive}) pesanan=${gt.ordersAll} ` +
      `pendapatan=${rupiah(gt.revAdmin)} ulasan=${gt.reviewCount} PAID=${gt.paidPayments}`,
  );

  const admin = await login("admin@mendungtirta.com");
  const seller = await login("nelayan.budi@mendungtirta.com");
  const buyer = await login("pembeli@mendungtirta.com");
  console.log("Login ADMIN/SELLER/BUYER: OK");

  const meOf = async (cookie: string): Promise<Me> => {
    const r = await api("/api/auth/me", { cookie });
    const u = (r.json as { user?: Record<string, unknown> } | null)?.user;
    if (!u || typeof u.name !== "string" || typeof u.email !== "string") {
      throw new Error("ground truth /api/auth/me tidak valid");
    }
    return { name: u.name, email: u.email, role: String(u.role ?? "") };
  };
  const adminMe = await meOf(admin);
  const sellerMe = await meOf(seller);
  const buyerMe = await meOf(buyer);

  /**
   * Jalankan SATU pertanyaan uji J: catat intent → kirim (paced) →
   * jalankan verifikasi → simpan baris audit.
   */
  const askJ = async (
    n: string,
    q: string,
    gtDesc: string,
    verify: (r: ChatResp) => void,
    role = "ADMIN",
  ): Promise<ChatResp> => {
    const det = await classifyChatbotIntent(q);
    const before = fail;
    console.log(`\n--- [${n}] ${q}`);
    console.log(
      `    intent=${det.intent} conf=${det.confidence} src=${det.source} | GT: ${gtDesc}`,
    );
    await pace(role);
    const r = await chat(role === "ADMIN" ? admin : role === "SELLER" ? seller : buyer, q);
    verify(r);
    console.log(
      `    chat: HTTP ${r.status} source=${r.source} reason=${r.fallbackReason ?? "-"} produk=${r.products.length}`,
    );
    auditRow(n, q, det.intent, gtDesc, r, fail === before);
    return r;
  };

  /* ================= J1. Ada produk apa saja? ===================== */
  await askJ(
    "J1",
    "Ada produk apa saja?",
    `produk visible=${gt.visible.length}`,
    (r) => {
      baseChecks("J1", r);
      notPii("J1", r, adminMe);
      matchProducts("J1", r, gt.visible);
      notEmptyClaim("J1", r, gt.visible.length);
    },
  );

  /* ================= J2. Berapa total produk? ===================== */
  await askJ(
    "J2",
    "Berapa total produk?",
    `totalProducts(visible)=${gt.visible.length}`,
    (r) => {
      baseChecks("J2", r);
      notPii("J2", r, adminMe);
      noProducts("J2", r);
      if (gt.visible.length > 0) {
        check(
          r.reply.includes(
            `Saat ini terdapat ${numPart(gt.visible.length)} produk terdaftar`,
          ),
          `J2: "Saat ini terdapat ${numPart(gt.visible.length)} produk terdaftar" (GT)`,
          detail(r),
        );
      } else {
        honestEmpty("J2", r);
      }
    },
  );

  /* ================= J3. Tampilkan semua produk. ================== */
  await askJ(
    "J3",
    "Tampilkan semua produk.",
    `produk visible=${gt.visible.length}`,
    (r) => {
      baseChecks("J3", r);
      notPii("J3", r, adminMe);
      matchProducts("J3", r, gt.visible);
      notEmptyClaim("J3", r, gt.visible.length);
    },
  );

  /* ================= J4. Produk hasil laut ======================== */
  await askJ(
    "J4",
    "Produk hasil laut apa saja?",
    `kategori "Hasil Laut"=${gt.kategoriLaut.length}`,
    (r) => {
      baseChecks("J4", r);
      notPii("J4", r, adminMe);
      matchProducts("J4", r, gt.kategoriLaut);
      notEmptyClaim("J4", r, gt.kategoriLaut.length);
    },
  );

  /* ================= J5. Harga < Rp50.000 ========================= */
  await askJ(
    "J5",
    "Produk di bawah Rp50.000.",
    `harga<50rb=${gt.lt50.length}`,
    (r) => {
      baseChecks("J5", r);
      notPii("J5", r, adminMe);
      matchProducts("J5", r, gt.lt50);
      notEmptyClaim("J5", r, gt.lt50.length);
    },
  );

  /* ================= J6. Harga > Rp50.000 ========================= */
  await askJ(
    "J6",
    "Produk di atas Rp50.000.",
    `harga>50rb=${gt.gt50.length}`,
    (r) => {
      baseChecks("J6", r);
      notPii("J6", r, adminMe);
      matchProducts("J6", r, gt.gt50);
      notEmptyClaim("J6", r, gt.gt50.length);
    },
  );

  /* ================= J7. Stok habis =============================== */
  await askJ(
    "J7",
    "Produk yang stoknya habis apa saja?",
    `stok habis=${gt.habis.length}`,
    (r) => {
      baseChecks("J7", r);
      notPii("J7", r, adminMe);
      if (gt.habis.length === 0) {
        honestEmpty("J7", r);
        check(
          r.products.length === 0,
          "J7: GT 0 → tanpa daftar produk",
          `dapat ${r.products.length}`,
        );
      } else {
        // Bisa berupa daftar produk ATAU jawaban hitungan — keduanya GT-true.
        const names = r.products.map((p) => p.name);
        const missing = gt.habis.filter(
          (p) => !names.includes(p.name) && !r.reply.includes(p.name),
        );
        check(
          missing.length === 0 || r.reply.includes(numPart(gt.habis.length)),
          `J7: produk habis tampil di produk/jawaban (GT=${gt.habis.length})`,
          missing.length ? `hilang: ${missing.map((p) => p.name).join(", ")}` : "",
        );
      }
    },
  );

  /* ================= J8. Dari toko tertentu ======================= */
  await askJ(
    "J8",
    "Produk dari toko Pancing Jaya Abadi.",
    `toko "Pancing Jaya Abadi"=${gt.tokoJaya.length}`,
    (r) => {
      baseChecks("J8", r);
      notPii("J8", r, adminMe);
      matchProducts("J8", r, gt.tokoJaya);
      notEmptyClaim("J8", r, gt.tokoJaya.length);
    },
  );

  /* ================= J9. Siapa saja seller? ======================= */
  await askJ(
    "J9",
    "Siapa saja seller?",
    `seller=${gt.sellers.length}`,
    (r) => {
      baseChecks("J9", r);
      notPii("J9", r, adminMe);
      noProducts("J9", r);
      check(
        r.reply.includes(`Daftar penjual (${gt.sellers.length})`),
        `J9: header "Daftar penjual (${gt.sellers.length})" sesuai GT`,
        detail(r),
      );
      for (const s of gt.sellers) {
        check(r.reply.includes(s.name), `J9: penjual "${s.name}" tampil`, detail(r));
      }
    },
  );

  /* ================= J10. Pengguna per role ======================= */
  await askJ(
    "J10",
    "Berapa jumlah pengguna setiap role?",
    `role A${gt.byRole.ADMIN}/S${gt.byRole.SELLER}/B${gt.byRole.BUYER} total=${gt.totalUsers}`,
    (r) => {
      baseChecks("J10", r);
      notPii("J10", r, adminMe);
      noProducts("J10", r);
      check(
        r.reply.includes(`- Admin: ${numPart(gt.byRole.ADMIN)}`),
        "J10: Admin = GT",
        detail(r),
      );
      check(
        r.reply.includes(`- Penjual (Seller): ${numPart(gt.byRole.SELLER)}`),
        "J10: Penjual = GT",
        detail(r),
      );
      check(
        r.reply.includes(`- Pembeli (Buyer): ${numPart(gt.byRole.BUYER)}`),
        "J10: Pembeli = GT",
        detail(r),
      );
      check(
        r.reply.includes(`Total: ${numPart(gt.totalUsers)} pengguna terdaftar.`),
        `J10: Total = ${gt.totalUsers} (penjumlahan GT)`,
        detail(r),
      );
    },
  );

  /* ================= J11. Toko aktif ============================== */
  await askJ(
    "J11",
    "Berapa jumlah toko aktif?",
    `toko aktif=${gt.storeActive}`,
    (r) => {
      baseChecks("J11", r);
      notPii("J11", r, adminMe);
      noProducts("J11", r);
      if (gt.storeActive > 0) {
        check(
          r.reply.includes(
            `Saat ini terdapat ${numPart(gt.storeActive)} toko aktif di Mendung Tirta.`,
          ),
          `J11: "${numPart(gt.storeActive)} toko aktif" (GT)`,
          detail(r),
        );
      } else {
        honestEmpty("J11", r);
      }
    },
  );

  /* ================= J12. Total pesanan =========================== */
  await askJ(
    "J12",
    "Berapa total pesanan?",
    `pesanan (semua)=${gt.ordersAll}`,
    (r) => {
      baseChecks("J12", r);
      notPii("J12", r, adminMe);
      noProducts("J12", r);
      if (gt.ordersAll > 0) {
        check(
          r.reply.includes(
            `Terdapat ${numPart(gt.ordersAll)} pesanan di marketplace.`,
          ),
          `J12: "Terdapat ${numPart(gt.ordersAll)} pesanan" (GT)`,
          detail(r),
        );
      } else {
        check(
          /Belum ada pesanan/i.test(r.reply),
          "J12: GT 0 → jawaban jujur",
          detail(r),
        );
      }
    },
  );

  /* ================= J13. Pendapatan ============================== */
  await askJ(
    "J13",
    "Berapa total pendapatan?",
    `pendapatan SQL=${rupiah(gt.revAdmin)}`,
    (r) => {
      baseChecks("J13", r);
      notPii("J13", r, adminMe);
      noProducts("J13", r);
      check(
        r.reply.includes(
          `Total pendapatan marketplace adalah ${rupiah(gt.revAdmin)}`,
        ),
        `J13: pendapatan marketplace = ${rupiah(gt.revAdmin)} (GT SQL)`,
        detail(r),
      );
    },
  );

  /* ================= J14. Jumlah ulasan =========================== */
  await askJ(
    "J14",
    "Berapa jumlah ulasan?",
    `ulasan=${gt.reviewCount}`,
    (r) => {
      baseChecks("J14", r);
      notPii("J14", r, adminMe);
      noProducts("J14", r);
      if (gt.reviewCount > 0) {
        check(
          r.reply.includes(
            `Saat ini terdapat ${numPart(gt.reviewCount)} ulasan di Mendung Tirta.`,
          ),
          `J14: "${numPart(gt.reviewCount)} ulasan" (GT)`,
          detail(r),
        );
      } else {
        check(/Belum ada ulasan/i.test(r.reply), "J14: GT 0 → jujur", detail(r));
      }
    },
  );

  /* ================= J15. Ringkasan marketplace =================== */
  await askJ(
    "J15",
    "Tampilkan ringkasan marketplace.",
    `stats pengguna=${gt.totalUsers} toko=${gt.storeTotal}(aktif ${gt.storeActive}) ` +
      `pendapatanΣ=${rupiah(gt.statsRev)} ulasan=${gt.reviewCount} PAID=${gt.paidPayments}`,
    (r) => {
      baseChecks("J15", r);
      notPii("J15", r, adminMe);
      noProducts("J15", r);
      check(
        r.reply.includes(`Jumlah pengguna total: ${numPart(gt.totalUsers)}`),
        "J15: total pengguna GT",
        detail(r),
      );
      check(
        r.reply.includes(
          `Toko terdaftar: ${gt.storeTotal} (aktif: ${gt.storeActive})`,
        ),
        "J15: toko terdaftar + aktif GT",
        detail(r),
      );
      check(
        r.reply.includes(
          `Pendapatan (pesanan dibayar/dikirim/selesai): ${rupiah(gt.statsRev)}`,
        ),
        `J15: pendapatan agregat = ${rupiah(gt.statsRev)} (GT Σ order.total)`,
        detail(r),
      );
      check(
        r.reply.includes(`Pembayaran berhasil (status PAID): ${numPart(gt.paidPayments)}`),
        `J15: pembayaran PAID = ${gt.paidPayments} (GT)`,
        detail(r),
      );
      check(
        r.reply.includes(`Ulasan: ${numPart(gt.reviewCount)}`) ||
          r.reply.includes(`Ulasan: ${gt.reviewCount}`),
        `J15: ulasan ${gt.reviewCount} (GT)`,
        detail(r),
      );
    },
  );

  /* ================= R1. SELLER browse katalog publik ============= */
  await askJ(
    "R1",
    "Ada produk apa saja?",
    `produk visible (publik)=${gt.visible.length}`,
    (r) => {
      baseChecks("R1", r);
      notPii("R1", r, sellerMe);
      matchProducts("R1", r, gt.visible);
      notEmptyClaim("R1", r, gt.visible.length);
    },
    "SELLER",
  );

  /* ================= R2. BUYER pesanan sendiri ==================== */
  await askJ(
    "R2",
    "Berapa total pesanan?",
    `pesanan BUYER sendiri=${gt.ordersBuyer} (global=${gt.ordersAll})`,
    (r) => {
      baseChecks("R2", r);
      notPii("R2", r, buyerMe);
      noProducts("R2", r);
      if (gt.ordersBuyer > 0) {
        check(
          r.reply.includes(`Anda memiliki ${numPart(gt.ordersBuyer)} pesanan`),
          `R2: "Anda memiliki ${numPart(gt.ordersBuyer)} pesanan" (GT milik sendiri)`,
          detail(r),
        );
      } else {
        check(/Anda belum memiliki pesanan/i.test(r.reply), "R2: GT 0 → jujur", detail(r));
      }
      // Tanpa kebocoran angka global (bila berbeda dari milik sendiri).
      if (gt.ordersAll !== gt.ordersBuyer && gt.ordersAll > 0) {
        check(
          !new RegExp(
            `\\b${numPart(gt.ordersAll).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          ).test(r.reply),
          `R2: TANPA bocoran jumlah global (${gt.ordersAll})`,
          detail(r),
        );
      }
    },
    "BUYER",
  );

  await db.$disconnect();

  /* ================= Tabel audit ringkas ========================== */
  header("AUDIT UJI J — 15 pertanyaan wajib + spot-check peran");
  const w = (s: string, n: number): string =>
    (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);
  console.log(
    `  ${w("#", 4)}${w("Pertanyaan", 42)}${w("Intent", 20)}${w("GT", 34)}${w("Chatbot", 30)}Hasil`,
  );
  for (const a of audits) {
    console.log(
      `  ${w(a.n, 4)}${w(a.q, 42)}${w(a.intent, 20)}${w(a.gt, 34)}${w(a.chat, 30)}${a.ok ? "LULUS" : "GAGAL"}`,
    );
  }

  console.log(`\n=== RINGKASAN UJI DATASET: ${pass} lulus, ${fail} gagal ===`);
  if (fail > 0) {
    console.log("Gagal:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("SEMUA UJI CAKUPAN DATASET (J1-J15 + R1-R2) LULUS ✔");
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

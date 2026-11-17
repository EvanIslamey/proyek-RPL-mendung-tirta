import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

/**
 * UJI PENCARIAN SELLER & DAFTAR PENGGUNA BERDASARKAN ROLE — 8 pertanyaan
 * wajib (Bagian 7 spesifikasi) × 3 peran login (ADMIN/SELLER/BUYER).
 *
 * Yang diverifikasi (semua jawaban dibandingkan GROUND TRUTH database):
 *  - Q1 "Siapa saja seller?"            → daftar penjual + toko (bukan produk)
 *  - Q2 "Berapa jumlah penjual?"        → jumlah penjual aktual (publik)
 *  - Q3 "Tampilkan semua nama toko."    → daftar toko + pemiliknya
 *  - Q4 "Siapa saja buyer?"             → ADMIN: daftar pembeli; non-admin: penolakan
 *  - Q5 "Ada berapa admin?"             → ADMIN: angka; non-admin: penolakan tanpa angka
 *  - Q6 "Tampilkan jumlah pengguna setiap role." → ADMIN: rincian; non-admin: penolakan
 *  - Q7 "Siapa penjual ikan kerapu?"    → penjual/toko pemilik produk tsb
 *  - Q8 "Tampilkan seller yang memiliki produk tersedia." → hanya penjual dgn produk AVAILABLE
 *
 * Hak akses: BUYER/SELLER hanya melihat penjual & toko AKTIF (info publik);
 * daftar pembeli/pengguna/admin = internal (hanya ADMIN). Tanpa email/PII,
 * tanpa daftar produk, tanpa angka karangan. Jawaban non-katalog wajib
 * source=fallback reason=direct (deterministik — tidak bergantung kuota AI).
 *
 * Rate limit chat 10 pesan/60 detik per akun → tiap peran dipacing PACE_MS;
 * tiga peran dijalankan PARALEL (rate limit per user). JANGAN jalankan skrip
 * ini bersamaan dengan skrip chatbot lain yang memakai akun sama.
 *
 * Usage: npx tsx scripts/test-chatbot-seller-list.mts
 * Exit 0 = semua pemeriksaan lulus.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
/** Jarak antar pesan per peran — jauh di bawah jendela rate limit 10/60s. */
const PACE_MS = 6800;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chat(cookie: string, message: string): Promise<ChatResp> {
  const r = await api("/api/ai/chat", { method: "POST", cookie, body: { message } });
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

/** Penanda jawaban berupa daftar/rekomendasi produk (dilarang utk non-katalog). */
const PRODUCT_LIST_RE =
  /berikut produk|rekomendasi|produk dari katalog|menampilkan \d+ produk/i;

/** Pola angka sesuai format backend (toLocaleString "id-ID" → "1.000"). */
const numPart = (n: number): string =>
  n.toLocaleString("id-ID").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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

/** Assertion dasar tiap jawaban: HTTP 200, non-empty, jalur deterministik. */
function baseChecks(label: string, r: ChatResp): void {
  check(r.status === 200, `${label}: HTTP 200`, `dapat ${r.status}`);
  check(r.reply.trim().length > 0, `${label}: jawaban non-empty`);
  check(
    r.source === "fallback" && r.fallbackReason === "direct",
    `${label}: jawaban deterministik (source=fallback reason=direct)`,
    `dapat ${r.source}/${r.fallbackReason}`,
  );
}

/** Jawaban pertanyaan daftar/hitungan TIDAK BOLEH menampilkan produk. */
function noProducts(label: string, r: ChatResp): void {
  check(r.products.length === 0, `${label}: tanpa daftar produk`, `dapat ${r.products.length} produk`);
  check(
    !PRODUCT_LIST_RE.test(r.reply),
    `${label}: tanpa rekomendasi produk`,
    r.reply.slice(0, 160),
  );
  check(!/\bRp\s?\d/i.test(r.reply), `${label}: tanpa harga produk (Rp…)`, r.reply.slice(0, 160));
}

/** Jawaban daftar/hitungan TIDAK BOLEH memuat PII (email login / profil). */
function notPii(label: string, r: ChatResp, me: Me): void {
  check(!r.reply.includes(me.email), `${label}: TIDAK menyertakan email login`);
  check(
    !/\bEmail:\s*\S/.test(r.reply) && !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(r.reply),
    `${label}: TANPA email/PII apa pun`,
    r.reply.slice(0, 160),
  );
}

/* ------------------------------------------------------------------ */
/* Ground truth database (bukan karangan)                              */
/* ------------------------------------------------------------------ */

type SellerRow = {
  name: string;
  isActive: boolean;
  store: {
    id: string;
    storeName: string;
    isActive: boolean;
    _count: { products: number };
  } | null;
};

type GT = {
  sellers: SellerRow[];
  /** storeId dengan ≥1 produk AVAILABLE & stok > 0. */
  availStoreIds: Set<string>;
  buyers: string[];
  adminCount: number;
  byRole: Record<string, number>;
  kerapu: { name: string; seller: string; store: string } | null;
};

type RoleName = "BUYER" | "SELLER" | "ADMIN";

/** Penjual/toko yang boleh dilihat peran ini (non-admin = AKTIF saja). */
function visibleSellers(gt: GT, role: RoleName): SellerRow[] {
  if (role === "ADMIN") return gt.sellers;
  return gt.sellers.filter(
    (s) => s.isActive && (!s.store || s.store.isActive),
  );
}

/** Penjual yang memiliki ≥1 produk tersedia (sesuai filter peran). */
function sellersWithAvailable(gt: GT, role: RoleName): SellerRow[] {
  return visibleSellers(gt, role).filter(
    (s) => s.store !== null && gt.availStoreIds.has(s.store.id),
  );
}

const QUESTIONS = [
  "Siapa saja seller?",
  "Berapa jumlah penjual?",
  "Tampilkan semua nama toko.",
  "Siapa saja buyer?",
  "Ada berapa admin?",
  "Tampilkan jumlah pengguna setiap role.",
  "Siapa penjual ikan kerapu?",
  "Tampilkan seller yang memiliki produk tersedia.",
] as const;

async function runRole(
  role: RoleName,
  cookie: string,
  me: Me,
  gt: GT,
): Promise<void> {
  header(`${role}: 8 pertanyaan daftar/role (dipacing ${PACE_MS}ms)`);

  const paced = async (message: string): Promise<ChatResp> => {
    const r = await chat(cookie, message);
    console.log(
      `\n[${role}] "${message}" → HTTP ${r.status} source=${r.source}` +
        `${r.fallbackReason ? ` reason=${r.fallbackReason}` : ""} produk=${r.products.length}`,
    );
    console.log(`  ${r.reply.slice(0, 260).replace(/\n/g, " | ")}`);
    await sleep(PACE_MS);
    return r;
  };

  const vis = visibleSellers(gt, role);
  const visStores = vis.filter((s) => s.store);
  const visAvail = sellersWithAvailable(gt, role);
  const visExcluded = gt.sellers.filter((s) => !vis.includes(s));
  const visNoAvail = vis.filter(
    (s) => !s.store || !gt.availStoreIds.has(s.store.id),
  );

  /* Q1. Siapa saja seller? → daftar penjual + toko (bukan produk) ------- */
  const q1 = await paced(QUESTIONS[0]);
  baseChecks(`${role} Q1 daftar seller`, q1);
  noProducts(`${role} Q1`, q1);
  notPii(`${role} Q1`, q1, me);
  check(
    new RegExp(`Daftar penjual \\(${vis.length}\\)`).test(q1.reply),
    `${role} Q1: header "Daftar penjual (${vis.length})" sesuai ground truth`,
    q1.reply.slice(0, 200),
  );
  check(/^\d+\.\s/m.test(q1.reply), `${role} Q1: berformat daftar bernomor`);
  for (const s of vis) {
    check(q1.reply.includes(s.name), `${role} Q1: penjual "${s.name}" tampil`, q1.reply.slice(0, 220));
    if (s.store) {
      check(
        q1.reply.includes(s.store.storeName),
        `${role} Q1: toko "${s.store.storeName}" tampil`,
        q1.reply.slice(0, 220),
      );
    }
  }
  check(/Akun: (Aktif|Nonaktif)/.test(q1.reply), `${role} Q1: status akun tampil`);
  check(/Toko: .+ \((Aktif|Nonaktif)\)|Toko: -/.test(q1.reply), `${role} Q1: status toko tampil`);
  check(
    /Produk: \d+ \(\d+ tersedia\)/.test(q1.reply),
    `${role} Q1: jumlah produk & produk tersedia tampil`,
    q1.reply.slice(0, 220),
  );
  for (const s of visExcluded) {
    check(
      !q1.reply.includes(s.name),
      `${role} Q1: penjual nonaktif "${s.name}" TIDAK bocor (hak akses)`,
    );
  }

  /* Q2. Berapa jumlah penjual? → angka aktual (publik, semua peran) ----- */
  const q2 = await paced(QUESTIONS[1]);
  baseChecks(`${role} Q2 jumlah penjual`, q2);
  noProducts(`${role} Q2`, q2);
  notPii(`${role} Q2`, q2, me);
  const nSeller = gt.sellers.length;
  check(
    q2.reply.includes(numPart(nSeller)) && /penjual/i.test(q2.reply),
    `${role} Q2: jumlah penjual = ${nSeller} (ground truth)`,
    q2.reply.slice(0, 200),
  );

  /* Q3. Tampilkan semua nama toko. → daftar toko + pemilik ------------- */
  const q3 = await paced(QUESTIONS[2]);
  baseChecks(`${role} Q3 daftar toko`, q3);
  noProducts(`${role} Q3`, q3);
  notPii(`${role} Q3`, q3, me);
  check(
    new RegExp(`Daftar toko \\(${visStores.length}\\)`).test(q3.reply),
    `${role} Q3: header "Daftar toko (${visStores.length})" sesuai ground truth`,
    q3.reply.slice(0, 200),
  );
  check(/^\d+\.\s/m.test(q3.reply), `${role} Q3: berformat daftar bernomor`);
  for (const s of visStores) {
    check(
      q3.reply.includes(s.store!.storeName),
      `${role} Q3: nama toko "${s.store!.storeName}" tampil`,
      q3.reply.slice(0, 220),
    );
    check(
      q3.reply.includes(`Pemilik: ${s.name}`),
      `${role} Q3: pemilik "${s.name}" tampil`,
      q3.reply.slice(0, 220),
    );
  }

  /* Q4. Siapa saja buyer? → ADMIN: daftar; non-admin: penolakan --------- */
  const q4 = await paced(QUESTIONS[3]);
  baseChecks(`${role} Q4 daftar buyer`, q4);
  noProducts(`${role} Q4`, q4);
  notPii(`${role} Q4`, q4, me);
  if (role === "ADMIN") {
    check(
      new RegExp(`Daftar pembeli \\(${gt.buyers.length}(?: akun)?\\)`).test(q4.reply),
      `${role} Q4: header "Daftar pembeli (${gt.buyers.length})" sesuai ground truth`,
      q4.reply.slice(0, 200),
    );
    for (const b of gt.buyers) {
      check(q4.reply.includes(b), `${role} Q4: pembeli "${b}" tampil`, q4.reply.slice(0, 200));
    }
  } else {
    check(
      /hanya dapat dilihat oleh admin/i.test(q4.reply),
      `${role} Q4: penolakan peran (hanya admin)`,
      q4.reply.slice(0, 200),
    );
    check(!/\d/.test(q4.reply), `${role} Q4: TANPA angka data internal`);
    for (const b of gt.buyers) {
      check(!q4.reply.includes(b), `${role} Q4: nama pembeli "${b}" TIDAK bocor`);
    }
  }

  /* Q5. Ada berapa admin? → ADMIN: angka; non-admin: penolakan ---------- */
  const q5 = await paced(QUESTIONS[4]);
  baseChecks(`${role} Q5 jumlah admin`, q5);
  noProducts(`${role} Q5`, q5);
  notPii(`${role} Q5`, q5, me);
  if (role === "ADMIN") {
    check(
      q5.reply.includes(numPart(gt.adminCount)) && /admin/i.test(q5.reply),
      `${role} Q5: jumlah admin = ${gt.adminCount} (ground truth)`,
      q5.reply.slice(0, 200),
    );
  } else {
    check(
      /hanya tersedia untuk admin/i.test(q5.reply),
      `${role} Q5: penolakan peran (hanya admin)`,
      q5.reply.slice(0, 200),
    );
    check(!/\d/.test(q5.reply), `${role} Q5: TANPA angka data internal`);
  }

  /* Q6. Tampilkan jumlah pengguna setiap role. → ADMIN: rincian -------- */
  const q6 = await paced(QUESTIONS[5]);
  baseChecks(`${role} Q6 pengguna per role`, q6);
  noProducts(`${role} Q6`, q6);
  notPii(`${role} Q6`, q6, me);
  if (role === "ADMIN") {
    for (const [code, label] of [
      ["ADMIN", "Admin"],
      ["SELLER", "Penjual"],
      ["BUYER", "Pembeli"],
    ] as const) {
      const n = gt.byRole[code] ?? 0;
      check(
        new RegExp(`${label}[^\\n]*:\\s*${numPart(n)}\\b`).test(q6.reply),
        `${role} Q6: rincian ${label} = ${n} (ground truth)`,
        q6.reply.slice(0, 240),
      );
    }
    const total = (gt.byRole.ADMIN ?? 0) + (gt.byRole.SELLER ?? 0) + (gt.byRole.BUYER ?? 0);
    check(
      new RegExp(`Total:\\s*${numPart(total)}\\s*pengguna`).test(q6.reply),
      `${role} Q6: Total = ${total} (penjumlahan ketiga role)`,
      q6.reply.slice(0, 240),
    );
  } else {
    check(
      /hanya tersedia untuk admin/i.test(q6.reply),
      `${role} Q6: penolakan peran (hanya admin)`,
      q6.reply.slice(0, 200),
    );
    check(!/\d/.test(q6.reply), `${role} Q6: TANPA angka data internal`);
  }

  /* Q7. Siapa penjual ikan kerapu? → pemilik toko produk tersebut ------- */
  const q7 = await paced(QUESTIONS[6]);
  baseChecks(`${role} Q7 penjual kerapu`, q7);
  noProducts(`${role} Q7`, q7);
  notPii(`${role} Q7`, q7, me);
  if (gt.kerapu) {
    check(
      q7.reply.includes(gt.kerapu.seller),
      `${role} Q7: penjual "${gt.kerapu.seller}" (pemilik kerapu) tampil`,
      q7.reply.slice(0, 220),
    );
    check(
      q7.reply.includes(gt.kerapu.store),
      `${role} Q7: toko "${gt.kerapu.store}" tampil`,
      q7.reply.slice(0, 220),
    );
    check(/kerapu/i.test(q7.reply), `${role} Q7: merujuk produk kerapu`);
  } else {
    check(false, `${role} Q7: ground truth produk kerapu tersedia di DB`);
  }

  /* Q8. Tampilkan seller yang memiliki produk tersedia. ----------------- */
  const q8 = await paced(QUESTIONS[7]);
  baseChecks(`${role} Q8 seller produk tersedia`, q8);
  noProducts(`${role} Q8`, q8);
  notPii(`${role} Q8`, q8, me);
  check(
    new RegExp(`Daftar penjual dengan produk tersedia \\(${visAvail.length}\\)`).test(q8.reply),
    `${role} Q8: header "…produk tersedia (${visAvail.length})" sesuai ground truth`,
    q8.reply.slice(0, 220),
  );
  check(/^\d+\.\s/m.test(q8.reply), `${role} Q8: berformat daftar bernomor`);
  check(
    /Produk: \d+ \([1-9]\d* tersedia\)/.test(q8.reply),
    `${role} Q8: tiap baris memuat ≥1 produk tersedia`,
    q8.reply.slice(0, 220),
  );
  for (const s of visAvail) {
    check(q8.reply.includes(s.name), `${role} Q8: penjual "${s.name}" (ada stok) tampil`, q8.reply.slice(0, 220));
  }
  for (const s of visNoAvail) {
    check(
      !q8.reply.includes(s.name),
      `${role} Q8: penjual tanpa produk tersedia "${s.name}" TIDAK ikut`,
    );
  }
}

async function main() {
  console.log(`Target: ${BASE}`);

  /* Ground truth database (langsung — bukan karangan) ------------------ */
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  const sellers = await prisma.user.findMany({
    where: { role: "SELLER" },
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
    orderBy: { name: "asc" },
  });
  const avail = await prisma.product.groupBy({
    by: ["storeId"],
    where: { status: "AVAILABLE", stock: { gt: 0 } },
    _count: { _all: true },
  });
  const buyers = await prisma.user.findMany({
    where: { role: "BUYER" },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
  const kerapuProduct = await prisma.product.findFirst({
    where: { name: { contains: "kerapu", mode: "insensitive" }, status: { not: "HIDDEN" } },
    select: {
      name: true,
      store: { select: { storeName: true, user: { select: { name: true } } } },
    },
  });

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

  const statsR = await api("/api/admin/stats", { cookie: admin });
  const stats = statsR.json as {
    users?: { total?: number; byRole?: Record<string, number> };
  } | null;
  if (statsR.status !== 200 || !stats?.users?.byRole) {
    check(false, "ground truth /api/admin/stats.users.byRole", `HTTP ${statsR.status}`);
  }

  const gt: GT = {
    sellers: sellers as SellerRow[],
    availStoreIds: new Set(avail.map((a) => a.storeId)),
    buyers: buyers.map((b) => b.name),
    adminCount,
    byRole: stats?.users?.byRole ?? {},
    kerapu: kerapuProduct
      ? {
          name: kerapuProduct.name,
          seller: kerapuProduct.store.user.name,
          store: kerapuProduct.store.storeName,
        }
      : null,
  };
  console.log(
    `Ground truth: penjual=${gt.sellers.length} pembeli=${gt.buyers.length} ` +
      `admin=${gt.adminCount} toko aktif(umum)=${gt.sellers.filter((s) => s.store).length} ` +
      `penjual+produk-tersedia=${sellersWithAvailable(gt, "ADMIN").length}`,
  );
  console.log(`Kerapu: ${gt.kerapu ? `${gt.kerapu.name} → ${gt.kerapu.seller} (${gt.kerapu.store})` : "TIDAK ADA"}`);
  console.log(`Akun: ADMIN="${adminMe.name}" SELLER="${sellerMe.name}" BUYER="${buyerMe.name}"`);

  header("8 pertanyaan daftar/role × 3 peran (paralel antar peran)");
  await Promise.all([
    runRole("BUYER", buyer, buyerMe, gt),
    runRole("SELLER", seller, sellerMe, gt),
    runRole("ADMIN", admin, adminMe, gt),
  ]);

  await prisma.$disconnect();

  /* Ringkasan ------------------------------------------------------- */
  console.log(`\n=== RINGKASAN: ${pass} lulus, ${fail} gagal ===`);
  if (fail > 0) {
    console.log("Gagal:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("SEMUA PEMERIKSAAN DAFTAR SELLER/ROLE LULUS ✔");
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

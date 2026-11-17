import "dotenv/config";

/**
 * UJI INTENT CHATBOT — CRITICAL FIX (12 pertanyaan wajib × 3 peran).
 *
 * Setiap pertanyaan diverifikasi terhadap data GROUND TRUTH dari API
 * (bukan karangan):
 * - pendapatan → /api/admin/stats.revenue & /api/seller/stats.sales.revenue
 *   (status transaksi yang sama: PROCESSING/SHIPPED/READY_FOR_PICKUP/COMPLETED);
 * - hitungan  → /api/admin/stats (peran), /api/orders, /api/seller/stats;
 * - pesanan   → cakupan MILIK SENDIRI / TOKO SENDIRI (tanpa bocoran ID);
 * - pertanyaan pendapatan/hitungan TIDAK PERNAH menampilkan produk
 *   (fallback salah dihapus — tidak ada rekomendasi katalog);
 * - pembatasan peran BUYER tidak pernah melihat angka statistik internal.
 *
 * Rate limit chat 10 pesan/60 detik per akun → tiap peran dipacing PACE_MS;
 * tiga peran dijalankan PARALEL (rate limit per user). JANGAN jalankan skrip
 * ini bersamaan dengan test-chatbot-suite/smoke yang memakai akun sama.
 *
 * Usage: npx tsx scripts/test-chatbot-intents.mts
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

type HistoryEntry = {
  role: "user" | "assistant";
  content: string;
  productIds?: string[];
};

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

async function chat(
  cookie: string,
  message: string,
  history?: HistoryEntry[],
): Promise<ChatResp> {
  // Retry bila kena 429: limit 10/60dtk per akun juga terisi oleh traffic
  // konkuren pada akun yang sama (mis. sesi AIWidget browser saat regresi
  // berjalan) — tunggu jendela lalu ulang, maksimal 3 percobaan.
  for (let attempt = 1; ; attempt++) {
    const r = await api("/api/ai/chat", {
      method: "POST",
      cookie,
      body: { message, ...(history ? { history } : {}) },
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

/** Format identik dengan rupiah() di backend (Math.round + locale id-ID). */
const rupiah = (n: number): string => `Rp${Math.round(n).toLocaleString("id-ID")}`;

/** Pola angka sesuai format backend (toLocaleString "id-ID" → "1.000"). */
const numRe = (n: number): RegExp =>
  new RegExp(
    `\\b${n.toLocaleString("id-ID").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
  );

/** Pola "N pembeli/pesanan" — deteksi kebocoran angka lintas peran. */
const leakRe = (n: number, entityAlternation: string): RegExp =>
  new RegExp(
    `${n.toLocaleString("id-ID").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:${entityAlternation})\\b`,
    "i",
  );

/** Penanda jawaban berupa daftar/rekomendasi produk (dilarang utk non-katalog). */
const PRODUCT_LIST_RE =
  /berikut produk|rekomendasi|produk dari katalog|menampilkan \d+ produk/i;

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

/** Jawaban pertanyaan non-katalog TIDAK BOLEH menampilkan produk. */
function noProducts(label: string, r: ChatResp): void {
  check(r.products.length === 0, `${label}: tanpa daftar produk`, `dapat ${r.products.length} produk`);
  check(
    !PRODUCT_LIST_RE.test(r.reply),
    `${label}: tanpa rekomendasi produk`,
    r.reply.slice(0, 160),
  );
}

type GroundTruth = {
  sellerCount: number;
  buyerCount: number;
  marketOrders: number;
  adminRevenue: number;
  sellerRevenue: number;
  buyerOrderCount: number;
  buyerOrderIds: string[];
  sellerOrderCount: number;
  sellerOrderIds: string[];
  adminOrderIds: string[];
};

const id8 = (v: unknown): string =>
  typeof v === "string" && v.length >= 6 ? v.slice(0, 8) : "";

const ordersIds = (j: Record<string, unknown> | null): string[] => {
  const arr = Array.isArray((j as { orders?: unknown[] } | null)?.orders)
    ? ((j as { orders: unknown[] }).orders as Record<string, unknown>[])
    : [];
  return arr.map((o) => id8(o.id)).filter(Boolean);
};

const itemIds = (j: Record<string, unknown> | null): string[] => {
  const arr = Array.isArray((j as { items?: unknown[] } | null)?.items)
    ? ((j as { items: unknown[] }).items as Record<string, unknown>[])
    : [];
  return arr.map((o) => id8(o.id)).filter(Boolean);
};

/* ------------------------------------------------------------------ */
/* Pertanyaan wajib (Bagian 10) — 12 untuk SETIAP peran               */
/* ------------------------------------------------------------------ */
const WAJIB = [
  "Berapa total pendapatan?",
  "Berapa pendapatan toko saya?",
  "Berapa jumlah penjual?",
  "Berapa jumlah pembeli?",
  "Berapa jumlah pesanan?",
  "Produk apa saja yang tersedia?",
  "Produk hasil laut di bawah Rp50.000?",
  "Berapa stok ikan kerapu?",
  "Pesanan saya sudah sampai mana?",
  "Siapa kamu?",
  "Apa aturan penggunaan Mendung Tirta?",
  "Jelaskan layanan Mendung Tirta.",
] as const;

type RoleName = "BUYER" | "SELLER" | "ADMIN";

async function runRole(
  role: RoleName,
  cookie: string,
  gt: GroundTruth,
): Promise<void> {
  header(`${role}: 12 pertanyaan wajib (dipacing ${PACE_MS}ms)`);
  const history: HistoryEntry[] = [];
  let first = true;

  const paced = async (
    message: string,
    opts?: { fresh?: boolean },
  ): Promise<ChatResp> => {
    if (!first) await sleep(PACE_MS);
    first = false;
    const r = await chat(
      cookie,
      message,
      !opts?.fresh && history.length ? history : undefined,
    );
    console.log(
      `\n[${role}] "${message}" → HTTP ${r.status} source=${r.source}` +
        `${r.fallbackReason ? ` reason=${r.fallbackReason}` : ""} produk=${r.products.length}`,
    );
    console.log(`  ${r.reply.slice(0, 240).replace(/\n/g, " ")}`);
    return r;
  };

  const remember = (message: string, r: ChatResp): void => {
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
  };

  /* Prelude: pertanyaan PRODUK dulu → riwayat memuat produk. Pertanyaan
   * pendapatan berikutnya wajib TETAP tanpa produk (bukti fallback salah
   * benar-benar terhapus walau ada konteks produk). */
  const prelude = await paced("Ada ikan kerapu?");
  baseChecks(`${role} prelude kerapu`, prelude);
  check(
    prelude.products.some((p) => /kerapu/i.test(p.name)) ||
      /kerapu/i.test(prelude.reply),
    `${role} prelude: menyebut/menampilkan kerapu`,
  );
  remember("Ada ikan kerapu?", prelude);

  /* 1. Berapa total pendapatan? ------------------------------------- */
  const q1 = await paced(WAJIB[0]);
  baseChecks(`${role} Q1 total pendapatan`, q1);
  noProducts(`${role} Q1`, q1);
  check(
    /pendapatan/i.test(q1.reply),
    `${role} Q1: membahas pendapatan (bukan rekomendasi produk)`,
    q1.reply.slice(0, 160),
  );
  // Penjelasan status & periode berlaku untuk yang MENGHITUNG (admin/penjual);
  // pembeli menerima penolakan peran (tanpa angka & tanpa detail kalkulasi).
  if (role !== "BUYER") {
    check(
      /Diproses, Dikirim, Siap Diambil/.test(q1.reply),
      `${role} Q1: menjelaskan status transaksi yang dihitung`,
      q1.reply.slice(0, 200),
    );
    check(
      /periode/i.test(q1.reply),
      `${role} Q1: menjelaskan periode perhitungan`,
      q1.reply.slice(0, 200),
    );
  }
  if (role === "ADMIN") {
    check(
      q1.reply.includes(rupiah(gt.adminRevenue)),
      `${role} Q1: memuat angka ground truth ${rupiah(gt.adminRevenue)}`,
      q1.reply.slice(0, 200),
    );
  } else if (role === "SELLER") {
    check(
      q1.reply.includes(rupiah(gt.sellerRevenue)),
      `${role} Q1: memuat angka ground truth ${rupiah(gt.sellerRevenue)}`,
      q1.reply.slice(0, 200),
    );
    check(/toko Anda/i.test(q1.reply), `${role} Q1: konteks "toko Anda"`);
  } else {
    check(/admin/i.test(q1.reply), `${role} Q1: penolakan peran (hanya admin/penjual)`);
    check(!/Rp\d/.test(q1.reply), `${role} Q1: TIDAK membocorkan angka rupiah`);
  }
  remember(WAJIB[0], q1);

  /* 2. Berapa pendapatan toko saya? --------------------------------- */
  const q2 = await paced(WAJIB[1]);
  baseChecks(`${role} Q2 pendapatan toko`, q2);
  noProducts(`${role} Q2`, q2);
  if (role === "SELLER") {
    check(
      q2.reply.includes(rupiah(gt.sellerRevenue)),
      `${role} Q2: memuat pendapatan toko ${rupiah(gt.sellerRevenue)}`,
      q2.reply.slice(0, 200),
    );
    check(/toko Anda/i.test(q2.reply), `${role} Q2: konteks "toko Anda"`);
  } else if (role === "ADMIN") {
    // Admin tidak punya toko sendiri → pendapatan marketplace sesuai aturan.
    check(
      q2.reply.includes(rupiah(gt.adminRevenue)),
      `${role} Q2: memuat pendapatan marketplace ${rupiah(gt.adminRevenue)}`,
      q2.reply.slice(0, 200),
    );
    check(/marketplace/i.test(q2.reply), `${role} Q2: konteks "marketplace"`);
  } else {
    check(/admin/i.test(q2.reply), `${role} Q2: penolakan peran`);
    check(!/Rp\d/.test(q2.reply), `${role} Q2: TIDAK membocorkan angka rupiah`);
  }
  remember(WAJIB[1], q2);

  /* 3. Berapa jumlah penjual? --------------------------------------- */
  const q3 = await paced(WAJIB[2]);
  baseChecks(`${role} Q3 jumlah penjual`, q3);
  noProducts(`${role} Q3`, q3);
  check(
    numRe(gt.sellerCount).test(q3.reply),
    `${role} Q3: memuat angka aktual ${gt.sellerCount}`,
    q3.reply.slice(0, 160),
  );
  check(/penjual/i.test(q3.reply), `${role} Q3: membahas penjual`);
  check(!/Rp\d/.test(q3.reply), `${role} Q3: tanpa angka rupiah (bukan pendapatan)`);
  remember(WAJIB[2], q3);

  /* 4. Berapa jumlah pembeli? --------------------------------------- */
  const q4 = await paced(WAJIB[3]);
  baseChecks(`${role} Q4 jumlah pembeli`, q4);
  noProducts(`${role} Q4`, q4);
  if (role === "ADMIN") {
    check(
      numRe(gt.buyerCount).test(q4.reply),
      `${role} Q4: memuat angka aktual ${gt.buyerCount}`,
      q4.reply.slice(0, 160),
    );
    check(/pembeli/i.test(q4.reply), `${role} Q4: membahas pembeli`);
  } else {
    check(/admin/i.test(q4.reply), `${role} Q4: data internal ditolak (admin)`);
    const leak = leakRe(gt.buyerCount, "pembeli|buyer");
    check(!leak.test(q4.reply), `${role} Q4: TIDAK membocorkan jumlah pembeli`);
  }
  remember(WAJIB[3], q4);

  /* 5. Berapa jumlah pesanan? --------------------------------------- */
  const q5 = await paced(WAJIB[4]);
  baseChecks(`${role} Q5 jumlah pesanan`, q5);
  noProducts(`${role} Q5`, q5);
  check(!/Rp\d/.test(q5.reply), `${role} Q5: jumlah pesanan BUKAN angka rupiah (tidak tercampur pendapatan)`);
  if (role === "ADMIN") {
    check(
      numRe(gt.marketOrders).test(q5.reply),
      `${role} Q5: memuat total pesanan marketplace ${gt.marketOrders}`,
      q5.reply.slice(0, 160),
    );
  } else if (role === "SELLER") {
    if (gt.sellerOrderCount === 0) {
      check(/belum memiliki pesanan/i.test(q5.reply), `${role} Q5: jawaban jujur (toko belum ada pesanan)`);
    } else {
      check(
        numRe(gt.sellerOrderCount).test(q5.reply),
        `${role} Q5: memuat jumlah pesanan toko ${gt.sellerOrderCount}`,
        q5.reply.slice(0, 160),
      );
      check(/Toko Anda/i.test(q5.reply), `${role} Q5: cakupan "Toko Anda"`);
    }
    if (gt.marketOrders !== gt.sellerOrderCount) {
      const leak = leakRe(gt.marketOrders, "pesanan|order|transaksi");
      check(!leak.test(q5.reply), `${role} Q5: TIDAK membocorkan total pesanan marketplace`);
    }
  } else {
    if (gt.buyerOrderCount === 0) {
      check(/belum memiliki pesanan/i.test(q5.reply), `${role} Q5: jawaban jujur (belum ada pesanan)`);
    } else {
      check(
        numRe(gt.buyerOrderCount).test(q5.reply),
        `${role} Q5: memuat jumlah pesanan sendiri ${gt.buyerOrderCount}`,
        q5.reply.slice(0, 160),
      );
    }
    if (gt.marketOrders !== gt.buyerOrderCount) {
      const leak = leakRe(gt.marketOrders, "pesanan|order|transaksi");
      check(!leak.test(q5.reply), `${role} Q5: TIDAK membocorkan total pesanan marketplace`);
    }
  }
  remember(WAJIB[4], q5);

  /* 6. Produk apa saja yang tersedia? ------------------------------ */
  const q6 = await paced(WAJIB[5]);
  baseChecks(`${role} Q6 produk tersedia`, q6);
  if (q6.products.length > 0) {
    check(
      q6.products.every((p) => p.stock > 0 && p.status !== "OUT_OF_STOCK" && p.status !== "HIDDEN"),
      `${role} Q6: semua produk tersedia (stok>0, bukan OUT_OF_STOCK/HIDDEN)`,
      JSON.stringify(q6.products.map((p) => ({ name: p.name, stock: p.stock, status: p.status }))),
    );
    check(
      q6.reply.includes(q6.products[0].name),
      `${role} Q6: jawaban menyebut produk yang ditampilkan`,
    );
  } else {
    check(/tidak|belum|kosong/i.test(q6.reply), `${role} Q6: jawaban jujur bila kosong`);
  }
  remember(WAJIB[5], q6);

  /* 7. Produk hasil laut di bawah Rp50.000? ------------------------- */
  const q7 = await paced(WAJIB[6]);
  baseChecks(`${role} Q7 hasil laut <50rb`, q7);
  if (q7.products.length > 0) {
    check(
      q7.products.every(
        (p) =>
          p.price < 50000 &&
          (p.categoryName ?? "").toLowerCase().includes("hasil laut"),
      ),
      `${role} Q7: harga <50.000 + kategori Hasil Laut`,
      JSON.stringify(q7.products.map((p) => ({ price: p.price, cat: p.categoryName }))),
    );
  } else {
    check(/tidak|belum|kosong/i.test(q7.reply), `${role} Q7: jawaban jujur bila kosong`);
  }
  remember(WAJIB[6], q7);

  /* 8. Berapa stok ikan kerapu? ------------------------------------- */
  const q8 = await paced(WAJIB[7]);
  baseChecks(`${role} Q8 stok kerapu`, q8);
  check(/kerapu/i.test(q8.reply), `${role} Q8: menyebut kerapu`, q8.reply.slice(0, 160));
  if (q8.products.length > 0) {
    check(
      q8.products.every((p) => /kerapu/i.test(p.name)),
      `${role} Q8: hanya menampilkan produk kerapu (fokus tepat)`,
      JSON.stringify(q8.products.map((p) => p.name)),
    );
  }
  remember(WAJIB[7], q8);

  /* 9. Pesanan saya sudah sampai mana? ----------------------------- */
  const q9 = await paced(WAJIB[8]);
  baseChecks(`${role} Q9 status pesanan`, q9);
  noProducts(`${role} Q9`, q9);
  check(/pesanan/i.test(q9.reply), `${role} Q9: membahas pesanan`, q9.reply.slice(0, 160));
  check(
    q9.fallbackReason !== "filtered",
    `${role} Q9: bukan jalur 'filtered'`,
    q9.fallbackReason ?? "(source=ai)",
  );
  const mentionedIds = [...q9.reply.matchAll(/#([0-9a-z]{6,})/gi)].map((m) => m[1]);
  if (role === "BUYER") {
    if (gt.buyerOrderCount > 0) {
      const isOwn = (mid: string): boolean =>
        gt.buyerOrderIds.some((own) => mid === own || mid.startsWith(own));
      const rogue = mentionedIds.filter((mid) => !isOwn(mid));
      check(rogue.length === 0, `${role} Q9: hanya pesanan milik sendiri`, rogue.join(", "));
      const listedOwn = mentionedIds.some(isOwn);
      const hasOwnCount = numRe(gt.buyerOrderCount).test(q9.reply);
      check(hasOwnCount || listedOwn, `${role} Q9: memuat jumlah/daftar pesanan sendiri`);
    } else {
      check(/belum memiliki pesanan|belum ada pesanan/i.test(q9.reply), `${role} Q9: jawaban jujur (belum ada pesanan)`);
    }
  } else if (role === "SELLER") {
    // Boleh menyebut pesanan toko sendiri; dilarang menyebut pesanan lain.
    const sellerOwn = new Set(gt.sellerOrderIds);
    const forbidden = mentionedIds.filter(
      (mid) => !sellerOwn.has(mid) && !sellerOwn.has(mid.slice(0, 8)),
    );
    const buyerNotSeller = gt.buyerOrderIds.filter((id) => !sellerOwn.has(id));
    const leak = forbidden.filter((mid) => buyerNotSeller.some((b) => mid === b || b.startsWith(mid)));
    check(leak.length === 0, `${role} Q9: tanpa bocoran pesanan non-toko`, leak.join(", "));
    if (gt.sellerOrderCount > 0) {
      check(
        mentionedIds.length > 0 || /Toko Anda|produk toko/i.test(q9.reply),
        `${role} Q9: menampilkan pesanan toko sendiri`,
      );
    }
  } else {
    // Admin: pesanan miliknya sendiri saja (bukan seluruh marketplace).
    const adminOwn = new Set(gt.adminOrderIds);
    const forbidden = mentionedIds.filter(
      (mid) => !adminOwn.has(mid) && !adminOwn.has(mid.slice(0, 8)),
    );
    const leak = forbidden.filter(
      (mid) =>
        gt.buyerOrderIds.some((b) => mid === b || b.startsWith(mid)) ||
        gt.sellerOrderIds.some((s) => mid === s || s.startsWith(mid)),
    );
    check(leak.length === 0, `${role} Q9: tanpa bocoran pesanan user lain`, leak.join(", "));
  }
  remember(WAJIB[8], q9);

  /* 10. Siapa kamu? ------------------------------------------------- */
  const q10 = await paced(WAJIB[9]);
  baseChecks(`${role} Q10 identitas`, q10);
  noProducts(`${role} Q10`, q10);
  check(
    /mendung tirta|asisten/i.test(q10.reply),
    `${role} Q10: memperkenalkan diri sebagai asisten Mendung Tirta`,
    q10.reply.slice(0, 160),
  );
  remember(WAJIB[9], q10);

  /* 11. Apa aturan penggunaan Mendung Tirta? ------------------------ */
  const q11 = await paced(WAJIB[10]);
  baseChecks(`${role} Q11 aturan penggunaan`, q11);
  noProducts(`${role} Q11`, q11);
  check(
    /panduan/i.test(q11.reply) && /mendung tirta/i.test(q11.reply),
    `${role} Q11: menjawab aturan/panduan penggunaan Mendung Tirta`,
    q11.reply.slice(0, 200),
  );
  remember(WAJIB[10], q11);

  /* 12. Jelaskan layanan Mendung Tirta. ----------------------------- */
  const q12 = await paced(WAJIB[11]);
  baseChecks(`${role} Q12 layanan`, q12);
  noProducts(`${role} Q12`, q12);
  check(
    /layanan/i.test(q12.reply) && /mendung tirta/i.test(q12.reply),
    `${role} Q12: menjelaskan layanan Mendung Tirta`,
    q12.reply.slice(0, 200),
  );
  remember(WAJIB[11], q12);

  /* Bonus (hanya BUYER): pertanyaan terbuka TANPA riwayat (sesi baru) →
   * wajib memakai jalur Gemini (source=ai) sebagai bukti integrasi provider
   * masih sehat setelah perubahan routing. Tanpa riwayat/kata kunci produk,
   * jawaban tidak bisa "meminjam" grounding katalog. */
  if (role === "BUYER") {
    const q13 = await paced("Mengapa langit biru di siang hari?", { fresh: true });
    baseChecks(`${role} bonus AI terbuka`, q13);
    check(
      q13.source === "ai",
      `${role} bonus: pertanyaan terbuka dijawab lewat AI/Gemini (source=ai)`,
      `source=${q13.source} reason=${q13.fallbackReason}`,
    );
    remember("Mengapa langit biru di siang hari?", q13);
  }
}

async function main() {
  console.log(`Target: ${BASE}`);

  const buyer = await login("pembeli@mendungtirta.com");
  const seller = await login("nelayan.budi@mendungtirta.com");
  const admin = await login("admin@mendungtirta.com");
  console.log("Login BUYER/SELLER/ADMIN: OK");

  /* Ground truth dari API (bukan karangan) -------------------------- */
  const statsR = await api("/api/admin/stats", { cookie: admin });
  const stats = statsR.json as {
    users?: { total?: number; byRole?: Record<string, number> };
    orders?: { total?: number };
    revenue?: number;
  } | null;

  const sellerStatsR = await api("/api/seller/stats", { cookie: seller });
  const sellerStats = sellerStatsR.json as {
    orders?: { total?: number };
    sales?: { revenue?: number };
  } | null;

  const buyerOrdersR = await api("/api/orders", { cookie: buyer });
  const sellerOrdersR = await api("/api/seller/orders", { cookie: seller });
  const adminOrdersR = await api("/api/orders", { cookie: admin });

  const buyerOrderIds = ordersIds(buyerOrdersR.json);
  const gt: GroundTruth = {
    sellerCount: stats?.users?.byRole?.SELLER ?? 0,
    buyerCount: stats?.users?.byRole?.BUYER ?? 0,
    marketOrders: stats?.orders?.total ?? 0,
    adminRevenue: Number(stats?.revenue ?? 0),
    sellerRevenue: Number(sellerStats?.sales?.revenue ?? 0),
    buyerOrderCount: buyerOrderIds.length,
    buyerOrderIds,
    sellerOrderCount: Number(sellerStats?.orders?.total ?? 0),
    sellerOrderIds: itemIds(sellerOrdersR.json),
    adminOrderIds: adminOrdersR.status === 200 ? ordersIds(adminOrdersR.json) : [],
  };

  if (statsR.status !== 200) {
    check(false, "ground truth /api/admin/stats", `HTTP ${statsR.status}`);
  }
  if (sellerStatsR.status !== 200) {
    check(false, "ground truth /api/seller/stats", `HTTP ${sellerStatsR.status}`);
  }
  console.log(
    `Ground truth: penjual=${gt.sellerCount} pembeli=${gt.buyerCount} ` +
      `pesananMarketplace=${gt.marketOrders} ` +
      `pendapatanMarketplace=${rupiah(gt.adminRevenue)} ` +
      `pendapatanToko=${rupiah(gt.sellerRevenue)} ` +
      `pesananPembeli=${gt.buyerOrderIds.length} pesananToko=${gt.sellerOrderCount}`,
  );

  header("12 pertanyaan wajib × 3 peran (paralel antar peran)");
  await Promise.all([
    runRole("BUYER", buyer, gt),
    runRole("SELLER", seller, gt),
    runRole("ADMIN", admin, gt),
  ]);

  /* Ringkasan ------------------------------------------------------- */
  console.log(`\n=== RINGKASAN: ${pass} lulus, ${fail} gagal ===`);
  if (fail > 0) {
    console.log("Gagal:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("SEMUA PEMERIKSAAN INTENT LULUS ✔");
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

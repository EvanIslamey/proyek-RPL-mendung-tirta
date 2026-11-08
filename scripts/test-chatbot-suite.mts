/**
 * SUITE UJI CHATBOT LIVE — 13 pertanyaan wajib (Bagian 10 master prompt)
 * + isolasi peran (BUYER/SELLER/ADMIN) + sweep PII + verifikasi filter
 * deterministik (fallbackReason="filtered") terhadap data AKTUAL database.
 *
 * Prasyarat:
 * - Server dev berjalan (http://localhost:3000) + DB terisi seed.
 * - Rate limit chat 10 pesan/60 detik per akun → buyer dipacing PACE_MS.
 *
 * Usage: npx tsx scripts/test-chatbot-suite.mts
 * Exit 0 = semua pemeriksaan lulus.
 */
import "dotenv/config";

const BASE = process.env.APP_URL ?? "http://localhost:3000";
/** Jarak antar pesan buyer — jauh di bawah jendela rate limit 10/60s. */
const PACE_MS = 6800;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
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
    source: typeof j.source === "string" ? j.source : undefined,
    fallbackReason:
      typeof j.fallbackReason === "string" ? j.fallbackReason : undefined,
  };
}

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

/** Assertion dasar tiap jawaban: HTTP 200, jawaban non-empty, sumber valid. */
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
      ["no-ai-config", "filtered", "provider-error"].includes(
        r.fallbackReason ?? "",
      ),
      `${label}: fallbackReason terisi`,
      `dapat ${r.fallbackReason}`,
    );
  }
}

async function main() {
  console.log(`Target: ${BASE}`);

  /* Login tiga peran ------------------------------------------------ */
  const buyer = await login("pembeli@mendungtirta.com");
  const seller = await login("nelayan.budi@mendungtirta.com");
  const admin = await login("admin@mendungtirta.com");
  console.log("Login BUYER/SELLER/ADMIN: OK");

  /* Ground truth dari API (bukan karangan) -------------------------- */
  const statsR = await api("/api/admin/stats", { cookie: admin });
  const stats = statsR.json as {
    users: { total: number; byRole: Record<string, number> };
    orders: { total: number };
  } | null;
  const sellerCount = stats?.users.byRole?.SELLER ?? 0;
  const userTotal = stats?.users?.total ?? 0;
  const marketOrders = stats?.orders?.total ?? 0;

  const buyerOrdersR = await api("/api/orders", { cookie: buyer });
  const buyerOrdersList = Array.isArray(
    (buyerOrdersR.json as { orders?: unknown[] } | null)?.orders,
  )
    ? (buyerOrdersR.json as { orders: { id?: unknown }[] }).orders
    : [];
  const buyerOrderCount = buyerOrdersList.length;
  const buyerOrderIds = buyerOrdersList
    .map((o) => (typeof o.id === "string" ? o.id.slice(0, 8) : ""))
    .filter((id) => id.length >= 6);

  const sellerOrdersR = await api("/api/seller/orders", { cookie: seller });
  const sellerOrderCount = Array.isArray(
    (sellerOrdersR.json as { items?: unknown[] } | null)?.items,
  )
    ? ((sellerOrdersR.json as { items: unknown[] }).items.length)
    : 0;

  console.log(
    `Ground truth: penjual=${sellerCount} pengguna=${userTotal} ` +
      `pesananPembeli=${buyerOrderCount} pesananToko=${sellerOrderCount} ` +
      `pesananMarketplace=${marketOrders}`,
  );

  /* ---------------- Bagian A: 13 pertanyaan wajib (BUYER) ---------- */
  header("A. 13 pertanyaan wajib (akun BUYER, dipacing)");
  let storeForQ10: string | null = null;
  let history: HistoryEntry[] = [];
  const buyerReplies: string[] = [];
  let q1: ChatResp | null = null;

  const paced = async (message: string, first = false): Promise<ChatResp> => {
    if (!first) await sleep(PACE_MS);
    const r = await chat(buyer, message, history.length ? history : undefined);
    console.log(
      `\nQ: "${message}" → HTTP ${r.status} source=${r.source}` +
        (r.fallbackReason ? ` reason=${r.fallbackReason}` : "") +
        ` produk=${r.products.length}`,
    );
    console.log(`  A: ${r.reply.slice(0, 220).replace(/\n/g, " ")}`);
    return r;
  };

  // Nama produk yang pernah muncul di jawaban — dipakai asersi Q13 bahwa
  // pertanyaan lanjutan dijawab dari KONTEKS percakapan, bukan produk acak.
  const seenProductNames = new Set<string>();

  const remember = (message: string, r: ChatResp): void => {
    history = [
      ...history,
      { role: "user" as const, content: message },
      {
        role: "assistant" as const,
        content: r.reply,
        ...(r.products.length
          ? { productIds: r.products.slice(0, 3).map((p) => p.id) }
          : {}),
      },
    ].slice(-8);
    buyerReplies.push(r.reply);
    for (const p of r.products) seenProductNames.add(p.name);
    if (!storeForQ10) {
      const withStore = r.products.find((p) => p.storeName);
      if (withStore) storeForQ10 = withStore.storeName;
    }
  };

  // 1. Ada ikan kerapu?
  q1 = await paced("Ada ikan kerapu?", true);
  baseChecks("Q1 kerapu", q1);
  check(
    q1.products.some((p) => /kerapu/i.test(p.name)) ||
      /kerapu/i.test(q1.reply),
    "Q1: menyebut/menampilkan kerapu",
  );
  remember("Ada ikan kerapu?", q1);

  // 2. Berapa stok ikan kerapu?
  const q2 = await paced("Berapa stok ikan kerapu?");
  baseChecks("Q2 stok kerapu", q2);
  remember("Berapa stok ikan kerapu?", q2);

  // 3. Produk hasil laut apa saja?
  const q3 = await paced("Produk hasil laut apa saja?");
  baseChecks("Q3 hasil laut", q3);
  if (q3.products.length > 0) {
    check(
      q3.products.every((p) =>
        (p.categoryName ?? "").toLowerCase().includes("hasil laut"),
      ),
      "Q3: semua produk berkategori Hasil Laut",
      JSON.stringify(q3.products.map((p) => p.categoryName)),
    );
  }
  remember("Produk hasil laut apa saja?", q3);

  // 4. Alat pancing apa saja?
  const q4 = await paced("Alat pancing apa saja?");
  baseChecks("Q4 alat pancing", q4);
  if (q4.products.length > 0) {
    check(
      q4.products.every((p) =>
        (p.categoryName ?? "").toLowerCase().includes("alat pancing"),
      ),
      "Q4: semua produk berkategori Alat Pancing",
      JSON.stringify(q4.products.map((p) => p.categoryName)),
    );
  }
  remember("Alat pancing apa saja?", q4);

  // 5. Produk di bawah Rp50.000.
  const q5 = await paced("Produk di bawah Rp50.000.");
  baseChecks("Q5 <50rb", q5);
  check(
    q5.source === "fallback" && q5.fallbackReason === "filtered",
    "Q5: jalur deterministik (filtered)",
    `source=${q5.source} reason=${q5.fallbackReason}`,
  );
  if (q5.products.length > 0) {
    check(
      q5.products.every((p) => p.price < 50000),
      "Q5: semua harga < 50.000",
      JSON.stringify(q5.products.map((p) => p.price)),
    );
  } else {
    check(/tidak|belum|kosong/i.test(q5.reply), "Q5: jawaban jujur bila kosong");
  }
  remember("Produk di bawah Rp50.000.", q5);

  // 6. Produk di atas Rp50.000.
  const q6 = await paced("Produk di atas Rp50.000.");
  baseChecks("Q6 >50rb", q6);
  check(
    q6.source === "fallback" && q6.fallbackReason === "filtered",
    "Q6: jalur deterministik (filtered)",
    `source=${q6.source} reason=${q6.fallbackReason}`,
  );
  if (q6.products.length > 0) {
    check(
      q6.products.every((p) => p.price > 50000),
      "Q6: semua harga > 50.000",
      JSON.stringify(q6.products.map((p) => p.price)),
    );
  } else {
    check(/tidak|belum|kosong/i.test(q6.reply), "Q6: jawaban jujur bila kosong");
  }
  remember("Produk di atas Rp50.000.", q6);

  // 7. Produk antara Rp30.000 dan Rp100.000.
  const q7 = await paced("Produk antara Rp30.000 dan Rp100.000.");
  baseChecks("Q7 rentang", q7);
  check(
    q7.source === "fallback" && q7.fallbackReason === "filtered",
    "Q7: jalur deterministik (filtered)",
    `source=${q7.source} reason=${q7.fallbackReason}`,
  );
  if (q7.products.length > 0) {
    check(
      q7.products.every((p) => p.price >= 30000 && p.price <= 100000),
      "Q7: semua harga 30.000–100.000",
      JSON.stringify(q7.products.map((p) => p.price)),
    );
  }
  remember("Produk antara Rp30.000 dan Rp100.000.", q7);

  // 8. Produk hasil laut di bawah Rp50.000 yang tersedia.
  const q8 = await paced("Produk hasil laut di bawah Rp50.000 yang tersedia.");
  baseChecks("Q8 kombinasi filter", q8);
  check(
    q8.source === "fallback" && q8.fallbackReason === "filtered",
    "Q8: jalur deterministik (filtered)",
    `source=${q8.source} reason=${q8.fallbackReason}`,
  );
  if (q8.products.length > 0) {
    check(
      q8.products.every(
        (p) =>
          p.price < 50000 &&
          p.stock > 0 &&
          (p.categoryName ?? "").toLowerCase().includes("hasil laut"),
      ),
      "Q8: harga<50rb + stok>0 + kategori Hasil Laut",
      JSON.stringify(
        q8.products.map((p) => ({
          price: p.price,
          stock: p.stock,
          cat: p.categoryName,
        })),
      ),
    );
  } else {
    check(/tidak|belum|kosong/i.test(q8.reply), "Q8: jawaban jujur bila kosong");
  }
  remember("Produk hasil laut di bawah Rp50.000 yang tersedia.", q8);

  // 9. Produk termurah.
  const q9 = await paced("Produk termurah.");
  baseChecks("Q9 termurah", q9);
  if (q9.products.length >= 2) {
    const sorted = [...q9.products].sort((a, b) => a.price - b.price);
    check(
      sorted[0].price === q9.products[0].price,
      "Q9: produk pertama termurah",
      JSON.stringify(q9.products.map((p) => p.price)),
    );
  } else if (q9.products.length === 0) {
    check(/tidak|belum|kosong/i.test(q9.reply), "Q9: jawaban jujur bila kosong");
  }
  remember("Produk termurah.", q9);

  // 10. Tampilkan produk dari toko tertentu.
  if (storeForQ10) {
    const q10 = await paced(`Tampilkan produk dari toko ${storeForQ10}.`);
    baseChecks("Q10 toko", q10);
    check(
      q10.source === "fallback" && q10.fallbackReason === "filtered",
      "Q10: jalur deterministik (filtered)",
      `source=${q10.source} reason=${q10.fallbackReason}`,
    );
    if (q10.products.length > 0) {
      check(
        q10.products.every((p) => p.storeName === storeForQ10),
        `Q10: semua produk dari toko "${storeForQ10}"`,
        JSON.stringify(q10.products.map((p) => p.storeName)),
      );
    } else {
      check(
        /tidak|belum|kosong/i.test(q10.reply),
        "Q10: jawaban jujur bila kosong",
      );
    }
    remember(`Tampilkan produk dari toko ${storeForQ10}.`, q10);
  } else {
    check(false, "Q10: memiliki nama toko dari pertanyaan sebelumnya");
  }

  // 11. Berapa jumlah penjual? (angka aktual, aturan prompt #18)
  const q11 = await paced("Berapa jumlah penjual?");
  baseChecks("Q11 jumlah penjual", q11);
  check(
    new RegExp(`\\b${sellerCount}\\b`).test(q11.reply),
    `Q11: jawaban memuat angka aktual ${sellerCount}`,
    q11.reply.slice(0, 160),
  );
  remember("Berapa jumlah penjual?", q11);

  // 12. Bagaimana status pesanan saya? (cakupan MILIK SENDIRI)
  const q12 = await paced("Bagaimana status pesanan saya?");
  baseChecks("Q12 pesanan saya", q12);
  check(
    /pesanan/i.test(q12.reply),
    "Q12: membahas pesanan",
    q12.reply.slice(0, 160),
  );
  // Regresi Q12: tanpa filter produk, pertanyaan akun BUKAN jalur "filtered".
  check(
    q12.fallbackReason !== "filtered",
    "Q12: bukan jalur 'filtered' (tanpa filter produk)",
    q12.fallbackReason ?? "(source=ai)",
  );
  if (buyerOrderCount > 0) {
    // Isolasi ketat: setiap ID pesanan yang disebut wajib milik pembeli ini.
    const mentionedIds = [...q12.reply.matchAll(/#([0-9a-z]{6,})/gi)].map((m) => m[1]);
    const isOwn = (mid: string): boolean =>
      buyerOrderIds.some((own) => mid === own || mid.startsWith(own));
    const rogueIds = mentionedIds.filter((mid) => !isOwn(mid));
    check(
      rogueIds.length === 0,
      "Q12: hanya menyebut pesanan milik sendiri (tanpa bocoran)",
      rogueIds.join(", "),
    );
    // Jawaban wajib memuat jumlah ATAU mendaftar pesanan sendiri.
    const hasOwnCount = new RegExp(`\\b${buyerOrderCount}\\b`).test(q12.reply);
    const listedOwn = mentionedIds.some(isOwn);
    check(
      hasOwnCount || listedOwn,
      `Q12: memuat jumlah (${buyerOrderCount}) ATAU daftar pesanan sendiri`,
      q12.reply.slice(0, 160),
    );
    if (marketOrders !== buyerOrderCount) {
      // Cek bocoran dengan pola "N pesanan" — substring telanjang SENGAJA
      // tidak dipakai: digit jam "08.41" dulu membuat assert palsu.
      const leak = new RegExp(`\\b${marketOrders}\\s+(?:pesanan|order|transaksi)\\b`, "i");
      check(
        !leak.test(q12.reply),
        "Q12: TIDAK membocorkan total pesanan marketplace",
      );
    }
  }
  remember("Bagaimana status pesanan saya?", q12);

  // 13. Pertanyaan lanjutan berbasis KONTEKS (riwayat dikirim) — contoh
  //     resmi Bagian 2G: "Ada ikan kerapu?" → "Berapa stoknya?".
  const q13 = await paced("Berapa stoknya?", false);
  baseChecks("Q13 konteks lanjutan", q13);
  check(
    history.length >= 4,
    "Q13: riwayat percakapan ikut terkirim",
    `history=${history.length}`,
  );
  // Regresi Q13: rujukan "-nya" dulu jadi subjek name yang mematikan
  // konteks — jawaban wajib memakai produk dari riwayat percakapan.
  check(
    q13.fallbackReason !== "filtered",
    "Q13: bukan jalur 'filtered' (rujukan '-nya' bukan filter produk)",
    q13.fallbackReason ?? "(source=ai)",
  );
  const ctxMentioned = [...seenProductNames].some((name) => {
    const core = name.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    if (!core) return false;
    const low = q13.reply.toLowerCase();
    if (low.includes(core)) return true;
    const words = core.split(" ");
    // Tanpa kemasan/kata pembuka ("kerapu macan segar") atau kata pembeda
    // berbatas kata ("kerapu", "minnow") — aturan prompt #1: nama persis.
    if (words.length > 2 && low.includes(words.slice(1).join(" "))) return true;
    return words.length > 1 && new RegExp(`\\b${words[1]}\\b`, "i").test(q13.reply);
  });
  check(
    ctxMentioned,
    "Q13: dijawab dari produk KONTEKS percakapan",
    q13.reply.slice(0, 200),
  );
  remember("Berapa stoknya?", q13);

  /* ---------------- Bagian B: isolasi peran ------------------------ */
  header("B. Isolasi peran");
  await sleep(PACE_MS); // jeda ekstra: kirim buyer berikutnya aman dari 10/60s

  // BUYER bertanya data internal platform → wajib ditolak (aturan prompt #19)
  const b1 = await chat(buyer, "Berapa jumlah pengguna?");
  console.log(`\nBUYER "Berapa jumlah pengguna?" → ${b1.reply.slice(0, 200)}`);
  baseChecks("BUYER jumlah pengguna", b1);
  check(
    /admin/i.test(b1.reply),
    "BUYER: data internal ditolak, disebutkan keterbatasan admin",
    b1.reply.slice(0, 160),
  );
  // Pola "N pengguna"/"pengguna … N" — substring telanjang sering salah
  // menuduh karena digit tanggal/jam ikut terhitung.
  const userLeak = new RegExp(
    `\\b${userTotal}\\s+(?:pengguna|akun|user)\\b` +
      `|\\b(?:pengguna|akun|user|total|jumlah)\\b[^\\n.]{0,25}\\b${userTotal}\\b`,
    "i",
  );
  check(
    !userLeak.test(b1.reply),
    "BUYER: angka total pengguna TIDAK dibocorkan",
    `total=${userTotal}`,
  );

  // SELLER: pesanan terbatas pada tokonya sendiri
  const s1 = await chat(seller, "Berapa jumlah pesanan yang masuk ke toko saya?");
  console.log(
    `\nSELLER "jumlah pesanan toko" → ${s1.reply.slice(0, 200)}`,
  );
  baseChecks("SELLER pesanan toko", s1);
  if (sellerOrderCount > 0) {
    check(
      new RegExp(`\\b${sellerOrderCount}\\b`).test(s1.reply),
      `SELLER: memuat jumlah pesanan tokonya (${sellerOrderCount})`,
      s1.reply.slice(0, 160),
    );
    if (marketOrders !== sellerOrderCount) {
      const sLeak = new RegExp(
        `\\b${marketOrders}\\s+(?:pesanan|order|transaksi)\\b` +
          `|\\b(?:pesanan|total)\\b[^\\n.]{0,25}\\b${marketOrders}\\b`,
        "i",
      );
      check(
        !sLeak.test(s1.reply),
        "SELLER: total pesanan marketplace TIDAK dibocorkan",
      );
    }
  }
  check(
    !EMAIL_RE.test(s1.reply),
    "SELLER: tanpa email pengguna lain (PII)",
  );

  // ADMIN: angka global boleh
  const a1 = await chat(admin, "Berapa jumlah pengguna?");
  console.log(`\nADMIN "Berapa jumlah pengguna?" → ${a1.reply.slice(0, 200)}`);
  baseChecks("ADMIN jumlah pengguna", a1);
  check(
    new RegExp(`\\b${userTotal}\\b`).test(a1.reply),
    `ADMIN: memuat total pengguna aktual (${userTotal})`,
    a1.reply.slice(0, 160),
  );

  /* ---------------- Bagian C: sweep PII pada semua jawaban --------- */
  header("C. Sweep PII (jawaban pembeli)");
  const leaked = buyerReplies.filter((r) => EMAIL_RE.test(r));
  check(
    leaked.length === 0,
    `tidak ada email di ${buyerReplies.length} jawaban pembeli`,
    leaked[0]?.slice(0, 120) ?? "",
  );

  /* ---------------- Ringkasan -------------------------------------- */
  header("RINGKASAN");
  console.log(`Lulus: ${pass}  Gagal: ${fail}`);
  if (fail > 0) {
    console.log("Detail kegagalan:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log(`\nKESIMPULAN: suite chatbot ${fail === 0 ? "BERHASIL" : "GAGAL"}`);
  process.exit(fail === 0 ? 0 : 2);
}

main().catch((e: unknown) => {
  console.error("GAGAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});

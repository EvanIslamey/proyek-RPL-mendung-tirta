import "dotenv/config";

/**
 * UJI ROLE & PEMBEDAAN INTENT — 8 pertanyaan wajib × 3 peran.
 *
 * Bug yang diverifikasi: "Ada apa saja role pengguna?" TIDAK BOLEH dijawab
 * dengan profil akun yang sedang login ("Informasi akun Anda: Nama …").
 *
 * Pemisahan yang diuji:
 * - Q1 "Ada apa saja role pengguna?"        → USER_ROLES  (jenis role)
 * - Q2–Q4 "Apa tugas admin/penjual/pembeli?"→ ROLE_PERMISSION (hak akses)
 * - Q5 "Apa perbedaan ketiganya?"           → USER_ROLES  (perbandingan)
 * - Q6 "Siapa saya?"                        → ACCOUNT_INFO (profil login)
 * - Q7 "Apa peran akun saya?"               → ACCOUNT_INFO (peran saat ini)
 * - Q8 "Berapa jumlah pengguna setiap role?"→ USER_COUNT   (rincian per role)
 *
 * Q1–Q5 & Q8: TANPA profil akun (email/Nama:/Email:), TANPA daftar produk.
 * Q6/Q7 justru WAJIB menampilkan profil/peran akun sendiri.
 * Q8: ADMIN → angka ground truth /api/admin/stats.users.byRole;
 *     SELLER/BUYER → penolakan peran (hanya admin), tanpa angka.
 *
 * Rate limit chat 10 pesan/60 detik per akun → tiap peran dipacing PACE_MS;
 * tiga peran dijalankan PARALEL (rate limit per user). JANGAN jalankan skrip
 * ini bersamaan dengan test-chatbot-suite/intents/smoke yang memakai akun sama.
 *
 * Usage: npx tsx scripts/test-chatbot-roles.mts
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

/** Penanda jawaban berupa daftar/rekomendasi produk (dilarang utk non-katalog). */
const PRODUCT_LIST_RE =
  /berikut produk|rekomendasi|produk dari katalog|menampilkan \d+ produk/i;

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  SELLER: "Penjual",
  BUYER: "Pembeli",
};

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

/** Jawaban role/hitungan TIDAK BOLEH memuat profil akun yang sedang login. */
function notProfile(label: string, r: ChatResp, me: Me): void {
  check(
    !r.reply.includes(me.email),
    `${label}: TIDAK menyertakan email login`,
    r.reply.slice(0, 160),
  );
  check(
    !/\bNama:\s*\S/.test(r.reply) && !/\bEmail:\s*\S/.test(r.reply),
    `${label}: BUKAN jawaban profil akun (tanpa baris Nama:/Email:)`,
    r.reply.slice(0, 160),
  );
}

type GroundTruth = {
  byRole: Record<string, number>;
};

const QUESTIONS = [
  "Ada apa saja role pengguna?",
  "Apa tugas admin?",
  "Apa tugas penjual?",
  "Apa tugas pembeli?",
  "Apa perbedaan ketiganya?",
  "Siapa saya?",
  "Apa peran akun saya?",
  "Berapa jumlah pengguna setiap role?",
] as const;

type RoleName = "BUYER" | "SELLER" | "ADMIN";

async function runRole(
  role: RoleName,
  cookie: string,
  me: Me,
  gt: GroundTruth,
): Promise<void> {
  header(`${role}: 8 pertanyaan role (dipacing ${PACE_MS}ms)`);
  const history: HistoryEntry[] = [];
  let first = true;

  const paced = async (message: string): Promise<ChatResp> => {
    if (!first) await sleep(PACE_MS);
    first = false;
    const r = await chat(
      cookie,
      message,
      history.length ? history : undefined,
    );
    console.log(
      `\n[${role}] "${message}" → HTTP ${r.status} source=${r.source}` +
        `${r.fallbackReason ? ` reason=${r.fallbackReason}` : ""} produk=${r.products.length}`,
    );
    console.log(`  ${r.reply.slice(0, 260).replace(/\n/g, " ")}`);
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

  /* Prelude: pertanyaan PRODUK dulu → riwayat memuat produk. Jawaban Q1–Q5
   * wajib tetap bebas profil & bebas produk (bukti pemisahan intent bekerja
   * walau konteks percakapan memuat data lain). */
  const prelude = await paced("Ada ikan kerapu?");
  baseChecks(`${role} prelude kerapu`, prelude);
  check(
    prelude.products.some((p) => /kerapu/i.test(p.name)) ||
      /kerapu/i.test(prelude.reply),
    `${role} prelude: menyebut/menampilkan kerapu`,
  );
  remember("Ada ikan kerapu?", prelude);

  /* Q1. Ada apa saja role pengguna? → USER_ROLES (BUKAN profil akun) ---- */
  const q1 = await paced(QUESTIONS[0]);
  baseChecks(`${role} Q1 jenis role`, q1);
  noProducts(`${role} Q1`, q1);
  notProfile(`${role} Q1`, q1, me);
  check(/role/i.test(q1.reply), `${role} Q1: membahas role`, q1.reply.slice(0, 160));
  check(
    /\bADMIN\b/.test(q1.reply) &&
      /(SELLER|Penjual)/i.test(q1.reply) &&
      /(BUYER|Pembeli)/i.test(q1.reply),
    `${role} Q1: menyebut ketiga role (Admin, Penjual, Pembeli)`,
    q1.reply.slice(0, 200),
  );

  /* Q1 juga menampilkan JUMLAH pengguna per role — COUNT real-time dari DB,
   * konsisten dengan /api/admin/stats (dashboard admin). Total = penjumlahan
   * ketiga role. Berlaku untuk SEMUA peran login; hanya angka (tanpa
   * email/PII — diverifikasi notProfile di atas). */
  const nAdmin = gt.byRole.ADMIN ?? 0;
  const nSeller = gt.byRole.SELLER ?? 0;
  const nBuyer = gt.byRole.BUYER ?? 0;
  const nTotal = nAdmin + nSeller + nBuyer;
  check(
    new RegExp(`1\\. ADMIN: ${nAdmin}\\b`).test(q1.reply),
    `${role} Q1: jumlah ADMIN = ${nAdmin} (aktual dari DB, = dashboard)`,
    q1.reply.slice(0, 240),
  );
  check(
    new RegExp(`2\\. SELLER \\(Penjual\\): ${nSeller}\\b`).test(q1.reply),
    `${role} Q1: jumlah SELLER (Penjual) = ${nSeller}`,
    q1.reply.slice(0, 240),
  );
  check(
    new RegExp(`3\\. BUYER \\(Pembeli\\): ${nBuyer}\\b`).test(q1.reply),
    `${role} Q1: jumlah BUYER (Pembeli) = ${nBuyer}`,
    q1.reply.slice(0, 240),
  );
  check(
    new RegExp(`4\\. Total pengguna: ${nTotal}\\b`).test(q1.reply),
    `${role} Q1: Total = ${nAdmin}+${nSeller}+${nBuyer} = ${nTotal} (penjumlahan ketiga role)`,
    q1.reply.slice(0, 240),
  );
  check(
    /\(\/profile\)/.test(q1.reply),
    `${role} Q1: seluruh blok role tampil utuh (tidak terpotong batas 1800)`,
    `panjang=${q1.reply.length}`,
  );
  remember(QUESTIONS[0], q1);

  /* Q2. Apa tugas admin? → ROLE_PERMISSION (hak akses admin) ----------- */
  const q2 = await paced(QUESTIONS[1]);
  baseChecks(`${role} Q2 tugas admin`, q2);
  noProducts(`${role} Q2`, q2);
  notProfile(`${role} Q2`, q2, me);
  check(
    /ADMIN \(Administrator\)/.test(q2.reply),
    `${role} Q2: menampilkan blok ADMIN`,
    q2.reply.slice(0, 200),
  );
  check(
    /Mengelola pengguna/i.test(q2.reply) && /Memantau pesanan/i.test(q2.reply),
    `${role} Q2: memuat hak akses admin (pengguna & pesanan)`,
    q2.reply.slice(0, 200),
  );
  check(
    !/SELLER \(Penjual\)/.test(q2.reply) && !/BUYER \(Pembeli\)/.test(q2.reply),
    `${role} Q2: TERFOKUS ke admin (bukan daftar semua role)`,
    q2.reply.slice(0, 200),
  );
  remember(QUESTIONS[1], q2);

  /* Q3. Apa tugas penjual? → ROLE_PERMISSION (hak akses seller) -------- */
  const q3 = await paced(QUESTIONS[2]);
  baseChecks(`${role} Q3 tugas penjual`, q3);
  noProducts(`${role} Q3`, q3);
  notProfile(`${role} Q3`, q3, me);
  check(
    /SELLER \(Penjual\)/.test(q3.reply),
    `${role} Q3: menampilkan blok SELLER`,
    q3.reply.slice(0, 200),
  );
  check(
    /Mengelola profil toko/i.test(q3.reply) &&
      /Menambahkan, mengubah, dan menghapus produk/i.test(q3.reply),
    `${role} Q3: memuat hak akses penjual (toko & produk)`,
    q3.reply.slice(0, 220),
  );
  check(
    !/ADMIN \(Administrator\)/.test(q3.reply) && !/BUYER \(Pembeli\)/.test(q3.reply),
    `${role} Q3: TERFOKUS ke penjual`,
    q3.reply.slice(0, 200),
  );
  remember(QUESTIONS[2], q3);

  /* Q4. Apa tugas pembeli? → ROLE_PERMISSION (hak akses buyer) --------- */
  const q4 = await paced(QUESTIONS[3]);
  baseChecks(`${role} Q4 tugas pembeli`, q4);
  noProducts(`${role} Q4`, q4);
  notProfile(`${role} Q4`, q4, me);
  check(
    /BUYER \(Pembeli\)/.test(q4.reply),
    `${role} Q4: menampilkan blok BUYER`,
    q4.reply.slice(0, 200),
  );
  check(
    /keranjang/i.test(q4.reply) && /ulasan/i.test(q4.reply),
    `${role} Q4: memuat hak akses pembeli (keranjang & ulasan)`,
    q4.reply.slice(0, 220),
  );
  check(
    !/ADMIN \(Administrator\)/.test(q4.reply) && !/SELLER \(Penjual\)/.test(q4.reply),
    `${role} Q4: TERFOKUS ke pembeli`,
    q4.reply.slice(0, 200),
  );
  remember(QUESTIONS[3], q4);

  /* Q5. Apa perbedaan ketiganya? → USER_ROLES (perbandingan ketiga) ---- */
  const q5 = await paced(QUESTIONS[4]);
  baseChecks(`${role} Q5 perbedaan ketiganya`, q5);
  noProducts(`${role} Q5`, q5);
  notProfile(`${role} Q5`, q5, me);
  check(
    /ADMIN \(Administrator\)/.test(q5.reply) &&
      /SELLER \(Penjual\)/.test(q5.reply) &&
      /BUYER \(Pembeli\)/.test(q5.reply),
    `${role} Q5: memuat ketiga role untuk dibandingkan`,
    q5.reply.slice(0, 220),
  );
  remember(QUESTIONS[4], q5);

  /* Q6. Siapa saya? → ACCOUNT_INFO (profil login — WAJIB tampil) ------- */
  const q6 = await paced(QUESTIONS[5]);
  baseChecks(`${role} Q6 siapa saya`, q6);
  noProducts(`${role} Q6`, q6);
  check(
    q6.reply.includes(me.name) && q6.reply.includes(me.email),
    `${role} Q6: menampilkan nama & email login (${me.name})`,
    q6.reply.slice(0, 200),
  );
  check(
    new RegExp(`Peran:\\s*${ROLE_LABEL[me.role] ?? me.role}`).test(q6.reply),
    `${role} Q6: menampilkan peran akun (${ROLE_LABEL[me.role] ?? me.role})`,
    q6.reply.slice(0, 200),
  );
  remember(QUESTIONS[5], q6);

  /* Q7. Apa peran akun saya? → ACCOUNT_INFO (peran saat ini) ----------- */
  const q7 = await paced(QUESTIONS[6]);
  baseChecks(`${role} Q7 peran akun`, q7);
  noProducts(`${role} Q7`, q7);
  check(
    new RegExp(`Peran:\\s*${ROLE_LABEL[me.role] ?? me.role}`).test(q7.reply),
    `${role} Q7: memuat peran akun saat ini (${ROLE_LABEL[me.role] ?? me.role})`,
    q7.reply.slice(0, 200),
  );
  remember(QUESTIONS[6], q7);

  /* Q8. Berapa jumlah pengguna setiap role? → USER_COUNT --------------- */
  const q8 = await paced(QUESTIONS[7]);
  baseChecks(`${role} Q8 pengguna per role`, q8);
  noProducts(`${role} Q8`, q8);
  notProfile(`${role} Q8`, q8, me);
  if (role === "ADMIN") {
    for (const [code, label] of [
      ["ADMIN", "Admin"],
      ["SELLER", "Penjual"],
      ["BUYER", "Pembeli"],
    ] as const) {
      const n = gt.byRole[code] ?? 0;
      check(
        new RegExp(`${label}[^\\n]*:\\s*${numPart(n)}\\b`).test(q8.reply),
        `${role} Q8: rincian ${label} = ${n} (ground truth)`,
        q8.reply.slice(0, 240),
      );
    }
  } else {
    check(
      /hanya tersedia untuk admin/i.test(q8.reply),
      `${role} Q8: penolakan peran (hanya admin)`,
      q8.reply.slice(0, 200),
    );
    check(!/\d/.test(q8.reply), `${role} Q8: TANPA angka statistik internal`);
  }
  remember(QUESTIONS[7], q8);
}

async function main() {
  console.log(`Target: ${BASE}`);

  const buyer = await login("pembeli@mendungtirta.com");
  const seller = await login("nelayan.budi@mendungtirta.com");
  const admin = await login("admin@mendungtirta.com");
  console.log("Login BUYER/SELLER/ADMIN: OK");

  /* Ground truth dari API (bukan karangan) -------------------------- */
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
  const gt: GroundTruth = { byRole: stats?.users?.byRole ?? {} };
  console.log(
    `Ground truth pengguna per role: Admin=${gt.byRole.ADMIN ?? 0} ` +
      `Penjual=${gt.byRole.SELLER ?? 0} Pembeli=${gt.byRole.BUYER ?? 0}`,
  );
  console.log(
    `Akun: ADMIN="${adminMe.name}" SELLER="${sellerMe.name}" BUYER="${buyerMe.name}"`,
  );

  header("8 pertanyaan role × 3 peran (paralel antar peran)");
  await Promise.all([
    runRole("BUYER", buyer, buyerMe, gt),
    runRole("SELLER", seller, sellerMe, gt),
    runRole("ADMIN", admin, adminMe, gt),
  ]);

  /* Ringkasan ------------------------------------------------------- */
  console.log(`\n=== RINGKASAN: ${pass} lulus, ${fail} gagal ===`);
  if (fail > 0) {
    console.log("Gagal:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("SEMUA PEMERIKSAAN ROLE & INTENT LULUS ✔");
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

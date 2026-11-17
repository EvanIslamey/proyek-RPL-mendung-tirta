import { PrismaClient } from "../prisma/generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

/**
 * UJI IDENTITAS PENGGUNA — chatbot harus MENYEBUTKAN NAMA pengguna dari
 * database (bukan hanya definisi role / angka total), dikelompokkan
 * ADMIN → SELLER → BUYER beserta jumlah masing-masing role.
 *
 * 7 uji wajib (spesifikasi identitas) — semua dibandingkan GROUND TRUTH
 * hasil query DB LANGSUNG (bukan HTTP 200 saja):
 *  1. Tampilkan semua pengguna (nama, role, status, toko, jumlah per role).
 *  2. Semua admin + namanya.
 *  3. Semua seller + nama tokonya.
 *  4. Semua buyer + namanya.
 *  5. Jumlah pengguna dicocokkan dengan daftar identitas (count == daftar).
 *  6. Variasi kalimat (11 frasa spesifikasi) → identitas yang sama.
 *  7. Hasil chatbot == isi database (tanpa nama karangan, tanpa PII).
 *  Plus hak akses: SELLER/BUYER tidak dapat melihat daftar pengguna internal
 *  (penolakan jujur, tanpa nama & tanpa angka internal).
 *
 * Pagination: halaman 1 memuat 10 baris + penanda halaman; "halaman 2"
 * (dengan riwayat percakapan) melanjutkan daftar yang sama — verifikasi
 * gabungan halaman 1+2 == SELURUH nama di database.
 *
 * Rate limit chat 10 pesan/60 detik per akun → tiap peran dipacing 7 dtk;
 * tiga peran dijalankan PARALEL (rate limit per user). JANGAN jalankan
 * skrip ini bersamaan dengan skrip chatbot lain yang memakai akun sama.
 *
 * Usage: npx tsx scripts/test-chatbot-user-identity.mts
 * Exit 0 = semua pemeriksaan lulus.
 */

const BASE = process.env.APP_URL ?? "http://localhost:3000";
/** Jarak antar pesan per peran — di bawah jendela rate limit 10/60 detik. */
const PACE_MS = 7000;

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  storeName: string;
};

type ChatResp = {
  status: number;
  reply: string;
  products: Product[];
  source?: string;
  fallbackReason?: string;
};

type HistoryEntry = { role: "user" | "assistant"; content: string };

type Me = { name: string; email: string; role: string };

type UserRow = {
  name: string;
  role: string;
  isActive: boolean;
  store: { storeName: string; isActive: boolean } | null;
};

type GT = {
  users: UserRow[];
  byRole: Record<string, number>;
  total: number;
  pancing: { storeName: string; owner: string } | null;
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
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await api("/api/ai/chat", {
      method: "POST",
      cookie,
      body: { message, ...(history && history.length ? { history } : {}) },
    });
    if (r.status === 429 && attempt < 3) {
      // Rate limit — beri jeda lalu coba lagi (bukan kegagalan data).
      await sleep(4000 * (attempt + 1));
      continue;
    }
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
  return { status: 429, reply: "", products: [] };
}

/** Penanda jawaban berupa daftar/rekomendasi produk (dilarang utk non-katalog). */
const PRODUCT_LIST_RE =
  /berikut produk|rekomendasi|produk dari katalog|menampilkan \d+ produk/i;

/** Pola angka sesuai format backend (toLocaleString "id-ID"). */
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

/** Assertion dasar: HTTP 200, non-empty, jalur deterministik tanpa kuota AI. */
function baseChecks(label: string, r: ChatResp): void {
  check(r.status === 200, `${label}: HTTP 200`, `dapat ${r.status}`);
  check(r.reply.trim().length > 0, `${label}: jawaban non-empty`);
  check(
    r.source === "fallback" && r.fallbackReason === "direct",
    `${label}: jawaban deterministik (source=fallback reason=direct)`,
    `dapat ${r.source}/${r.fallbackReason}`,
  );
}

/** Jawaban identitas TIDAK BOLEH menampilkan produk/harga. */
function noProducts(label: string, r: ChatResp): void {
  check(r.products.length === 0, `${label}: tanpa daftar produk`, `dapat ${r.products.length} produk`);
  check(
    !PRODUCT_LIST_RE.test(r.reply),
    `${label}: tanpa rekomendasi produk`,
    r.reply.slice(0, 160),
  );
  check(!/\bRp\s?\d/i.test(r.reply), `${label}: tanpa harga produk (Rp…)`, r.reply.slice(0, 160));
}

/** Tanpa PII/kredensial apa pun (email, password, token, API key). */
function notPii(label: string, r: ChatResp, me: Me): void {
  check(!r.reply.includes(me.email), `${label}: TIDAK menyertakan email login`);
  check(
    !/@[a-z0-9.-]+\.[a-z]{2,}/i.test(r.reply),
    `${label}: TANPA email/PII apa pun`,
    r.reply.slice(0, 160),
  );
  check(
    !/\bEmail:\s*\S/i.test(r.reply),
    `${label}: tanpa baris Email:`,
    r.reply.slice(0, 160),
  );
  check(
    !/password|passwd|hash|access[_ -]?token|api[_ -]?key|secret/i.test(r.reply),
    `${label}: TANPA password/token/API key`,
    r.reply.slice(0, 160),
  );
}

/** Daftar bernomor + tiap nama wajib tampil (identitas nyata, bukan karangan). */
function hasListedNames(label: string, reply: string, names: string[]): void {
  check(/^\d+\.\s/m.test(reply), `${label}: berformat daftar bernomor`);
  for (const name of names) {
    check(reply.includes(name), `${label}: nama "${name}" tampil dari database`, reply.slice(0, 240));
  }
}

type RoleName = "BUYER" | "SELLER" | "ADMIN";

async function runAdmin(cookie: string, me: Me, gt: GT): Promise<void> {
  header(`ADMIN: uji identitas pengguna (dipacing ${PACE_MS}ms)`);
  const history: HistoryEntry[] = [];
  let first = true;

  const paced = async (message: string): Promise<ChatResp> => {
    if (!first) await sleep(PACE_MS);
    first = false;
    const r = await chat(cookie, message, history.length ? history : undefined);
    console.log(
      `\n[ADMIN] "${message}" → HTTP ${r.status} source=${r.source}` +
        `${r.fallbackReason ? ` reason=${r.fallbackReason}` : ""} produk=${r.products.length}`,
    );
    console.log(`  ${r.reply.slice(0, 320).replace(/\n/g, " | ")}`);
    history.push(
      { role: "user", content: message },
      { role: "assistant", content: r.reply },
    );
    while (history.length > 8) history.shift();
    return r;
  };

  const pageSize = 10;
  const page1 = gt.users.slice(0, pageSize).map((u) => u.name);
  const page2 = gt.users.slice(pageSize).map((u) => u.name);
  const totalPages = Math.max(1, Math.ceil(gt.total / pageSize));
  const summary =
    `Total pengguna: ${gt.total} — ADMIN: ${gt.byRole.ADMIN ?? 0}, ` +
    `SELLER (Penjual): ${gt.byRole.SELLER ?? 0}, BUYER (Pembeli): ${gt.byRole.BUYER ?? 0}.`;

  /* 1. Tampilkan semua pengguna → kelompok + jumlah per role + halaman. */
  const q1 = await paced("Tampilkan semua pengguna.");
  baseChecks("Q1 semua pengguna", q1);
  noProducts("Q1", q1);
  notPii("Q1", q1, me);
  check(q1.reply.includes(summary), "Q1: ringkasan total + jumlah per role sesuai GT", q1.reply.slice(0, 240));
  for (const code of ["ADMIN", "SELLER", "BUYER"] as const) {
    const n = gt.byRole[code] ?? 0;
    check(
      new RegExp(`^${code} \\(${numPart(n)}\\):$`, "m").test(q1.reply),
      `Q1: kelompok ${code} (${n}) tampil`,
      q1.reply.slice(0, 300),
    );
  }
  hasListedNames("Q1", q1.reply, page1);
  if (page2.length > 0) {
    for (const name of page2) {
      check(
        !q1.reply.includes(name),
        `Q1: nama halaman 2 "${name}" TIDAK bocor ke halaman 1 (paginasi jujur)`,
      );
    }
    check(
      q1.reply.includes(`Halaman 1 dari ${totalPages}`),
      `Q1: penanda halaman 1 dari ${totalPages} (daftar tidak dipotong diam-diam)`,
      q1.reply.slice(-220),
    );
  }

  /* 2. "halaman 2" (retensi riwayat) → sisa nama, lengkap seluruh database. */
  if (page2.length > 0) {
    const q1b = await paced("halaman 2");
    baseChecks("Q1b halaman 2", q1b);
    notPii("Q1b", q1b, me);
    check(
      q1b.reply.includes(`Halaman 2 dari ${totalPages}`),
      `Q1b: menampilkan halaman 2 dari ${totalPages}`,
      q1b.reply.slice(-220),
    );
    hasListedNames("Q1b", q1b.reply, page2);
  }

  /* 3. Siapa saja admin? */
  const q2 = await paced("Siapa saja admin?");
  baseChecks("Q2 daftar admin", q2);
  noProducts("Q2", q2);
  notPii("Q2", q2, me);
  const admins = gt.users.filter((u) => u.role === "ADMIN");
  check(
    new RegExp(`Daftar admin \\(${numPart(admins.length)} akun\\)`).test(q2.reply),
    `Q2: header "Daftar admin (${admins.length} akun)" sesuai GT`,
    q2.reply.slice(0, 200),
  );
  hasListedNames("Q2", q2.reply, admins.map((u) => u.name));
  check(
    q2.reply.includes(`Total admin: ${admins.length}.`),
    `Q2: total admin = ${admins.length} (jumlah aktual)`,
    q2.reply.slice(-200),
  );

  /* 4. Siapa saja seller/penjual → nama + toko. */
  const q3 = await paced("Siapa saja seller atau penjual?");
  baseChecks("Q3 daftar penjual", q3);
  noProducts("Q3", q3);
  notPii("Q3", q3, me);
  const sellers = gt.users.filter((u) => u.role === "SELLER");
  check(
    new RegExp(`Daftar penjual \\(${numPart(sellers.length)}\\)`).test(q3.reply),
    `Q3: header "Daftar penjual (${sellers.length})" sesuai GT`,
    q3.reply.slice(0, 200),
  );
  hasListedNames("Q3", q3.reply, sellers.map((u) => u.name));
  for (const s of sellers) {
    check(
      s.store
        ? q3.reply.includes(`Toko: ${s.store.storeName} (`)
        : q3.reply.includes("Toko: -"),
      `Q3: toko penjual "${s.name}" sesuai relasi database`,
      q3.reply.slice(0, 260),
    );
  }
  check(
    q3.reply.includes(`Total penjual: ${sellers.length}.`),
    `Q3: total penjual = ${sellers.length} (jumlah aktual)`,
    q3.reply.slice(-200),
  );

  /* 5. Siapa saja buyer/pembeli. */
  const q4 = await paced("Siapa saja buyer atau pembeli?");
  baseChecks("Q4 daftar pembeli", q4);
  noProducts("Q4", q4);
  notPii("Q4", q4, me);
  const buyers = gt.users.filter((u) => u.role === "BUYER");
  check(
    new RegExp(`Daftar pembeli \\(${numPart(buyers.length)} akun\\)`).test(q4.reply),
    `Q4: header "Daftar pembeli (${buyers.length} akun)" sesuai GT`,
    q4.reply.slice(0, 200),
  );
  hasListedNames("Q4", q4.reply, buyers.map((u) => u.name));
  check(
    q4.reply.includes(`Total pembeli: ${buyers.length}.`),
    `Q4: total pembeli = ${buyers.length} (jumlah aktual)`,
    q4.reply.slice(-200),
  );

  /* 6. Jumlah + identitas harus COCOK satu sama lain. */
  const q5 = await paced("Ada berapa pengguna dan siapa namanya?");
  baseChecks("Q5 jumlah + nama", q5);
  noProducts("Q5", q5);
  notPii("Q5", q5, me);
  check(
    new RegExp(`terdapat\\s+${numPart(gt.total)}\\s+pengguna terdaftar`).test(q5.reply),
    `Q5: jumlah = ${gt.total} (ground truth DB)`,
    q5.reply.slice(0, 240),
  );
  check(
    q5.reply.includes(`Total pengguna: ${gt.total}`),
    "Q5: total pada daftar identitas == jumlah (cocok)",
    q5.reply.slice(0, 240),
  );
  hasListedNames("Q5", q5.reply, page1);

  /* 7. Variasi kalimat — identitas yang sama dari database. */
  const q6 = await paced("Siapa saja pengguna Mendung Tirta?");
  baseChecks("Q6 variasi semua pengguna", q6);
  noProducts("Q6", q6);
  notPii("Q6", q6, me);
  check(q6.reply.includes(summary), "Q6: ringkasan per role sesuai GT", q6.reply.slice(0, 240));
  hasListedNames("Q6", q6.reply, page1);

  const q7 = await paced("Siapa nama seluruh penjual?");
  baseChecks("Q7 variasi nama penjual", q7);
  noProducts("Q7", q7);
  notPii("Q7", q7, me);
  hasListedNames("Q7", q7.reply, sellers.map((u) => u.name));
  for (const s of sellers) {
    if (s.store) {
      check(
        q7.reply.includes(s.store.storeName),
        `Q7: toko "${s.store.storeName}" ikut disebut`,
        q7.reply.slice(0, 260),
      );
    }
  }

  /* 8. Pengguna AKTIF — saring status, tanpa nama nonaktif. */
  const active = gt.users.filter((u) => u.isActive);
  const inactive = gt.users.filter((u) => !u.isActive);
  const q8 = await paced("Siapa saja pengguna yang aktif?");
  baseChecks("Q8 pengguna aktif", q8);
  noProducts("Q8", q8);
  notPii("Q8", q8, me);
  if (active.length === 0) {
    check(
      /belum ada pengguna dengan status aktif/i.test(q8.reply),
      "Q8: jujur 'belum ada' (GT kosong)",
      q8.reply.slice(0, 200),
    );
  } else {
    check(
      new RegExp(`Daftar pengguna aktif \\(${numPart(active.length)} akun\\)`).test(q8.reply),
      `Q8: header aktif (${active.length} akun) sesuai GT`,
      q8.reply.slice(0, 200),
    );
    hasListedNames("Q8", q8.reply, active.slice(0, pageSize).map((u) => u.name));
    for (const u of inactive) {
      check(
        !q8.reply.includes(u.name),
        `Q8: pengguna nonaktif "${u.name}" TIDAK ikut daftar aktif`,
      );
    }
  }

  /* 9. Pengguna BELUM AKTIF — jujur bila kosong. */
  const q9 = await paced("Siapa saja pengguna yang belum aktif?");
  baseChecks("Q9 pengguna belum aktif", q9);
  noProducts("Q9", q9);
  notPii("Q9", q9, me);
  if (inactive.length === 0) {
    check(
      /belum ada pengguna dengan status belum aktif/i.test(q9.reply),
      "Q9: jujur 'belum ada pengguna belum aktif' (GT kosong, tanpa karangan)",
      q9.reply.slice(0, 220),
    );
    for (const u of gt.users) {
      check(!q9.reply.includes(u.name), `Q9: tanpa nama karangan "${u.name}"`);
    }
  } else {
    check(
      new RegExp(`Daftar pengguna belum aktif \\(${numPart(inactive.length)} akun\\)`).test(
        q9.reply,
      ),
      `Q9: header belum aktif (${inactive.length} akun) sesuai GT`,
      q9.reply.slice(0, 200),
    );
    hasListedNames("Q9", q9.reply, inactive.slice(0, pageSize).map((u) => u.name));
    for (const u of active) {
      check(
        !q9.reply.includes(u.name),
        `Q9: pengguna aktif "${u.name}" TIDAK ikut daftar belum aktif`,
      );
    }
  }

  /* 10. Daftar pengguna berdasarkan role (kelompok + hitungan). */
  const q10 = await paced("Tampilkan daftar pengguna berdasarkan role.");
  baseChecks("Q10 daftar per role", q10);
  noProducts("Q10", q10);
  notPii("Q10", q10, me);
  check(q10.reply.includes(summary), "Q10: ringkasan per role sesuai GT", q10.reply.slice(0, 240));
  hasListedNames("Q10", q10.reply, page1);

  /* 11. Pemilik toko (satu orang) — relasi User–Store benar. */
  if (gt.pancing) {
    const q11 = await paced(`Siapa pemilik toko ${gt.pancing.storeName}?`);
    baseChecks("Q11 pemilik toko", q11);
    noProducts("Q11", q11);
    notPii("Q11", q11, me);
    check(
      q11.reply.includes(gt.pancing.owner),
      `Q11: pemilik "${gt.pancing.owner}" tampil (relasi User–Store)`,
      q11.reply.slice(0, 240),
    );
    check(
      q11.reply.includes(gt.pancing.storeName),
      `Q11: nama toko "${gt.pancing.storeName}" tampil`,
      q11.reply.slice(0, 240),
    );
  } else {
    check(false, "Q11: ground truth toko 'Pancing…' tersedia di DB");
  }

  /* 12. Nama penjual + nama toko dalam satu daftar. */
  const q12 = await paced("Sebutkan nama penjual beserta nama tokonya.");
  baseChecks("Q12 penjual + toko", q12);
  noProducts("Q12", q12);
  notPii("Q12", q12, me);
  hasListedNames("Q12", q12.reply, sellers.map((u) => u.name));
  for (const s of sellers) {
    if (s.store) {
      check(
        q12.reply.includes(s.store.storeName),
        `Q12: toko "${s.store.storeName}" tampil bersama penjual`,
        q12.reply.slice(0, 260),
      );
    }
  }
}

async function runRole(role: RoleName, cookie: string, me: Me, gt: GT): Promise<void> {
  header(`${role}: hak akses — identitas internal ditolak jujur`);
  let first = true;
  const paced = async (message: string): Promise<ChatResp> => {
    if (!first) await sleep(PACE_MS);
    first = false;
    const r = await chat(cookie, message);
    console.log(
      `\n[${role}] "${message}" → HTTP ${r.status} source=${r.source}` +
        `${r.fallbackReason ? ` reason=${r.fallbackReason}` : ""} produk=${r.products.length}`,
    );
    console.log(`  ${r.reply.slice(0, 260).replace(/\n/g, " | ")}`);
    return r;
  };

  const allNames = gt.users.map((u) => u.name);

  /* A. Daftar pengguna internal → penolakan tanpa nama & tanpa angka. */
  const a = await paced("Siapa saja pengguna?");
  baseChecks(`${role} A daftar pengguna`, a);
  noProducts(`${role} A`, a);
  check(
    /hanya dapat dilihat oleh admin/i.test(a.reply),
    `${role} A: penolakan peran (hanya admin)`,
    a.reply.slice(0, 200),
  );
  check(!/\d/.test(a.reply), `${role} A: TANPA angka data internal`);
  for (const name of allNames) {
    check(!a.reply.includes(name), `${role} A: nama "${name}" TIDAK bocor`);
  }

  /* B. Daftar pembeli internal → penolakan. */
  const b = await paced("Siapa saja buyer?");
  baseChecks(`${role} B daftar pembeli`, b);
  noProducts(`${role} B`, b);
  check(
    /hanya dapat dilihat oleh admin/i.test(b.reply),
    `${role} B: penolakan peran (hanya admin)`,
    b.reply.slice(0, 200),
  );
  check(!/\d/.test(b.reply), `${role} B: TANPA angka data internal`);

  /* C. Daftar penjual/toko = info publik → tetap boleh (akun/toko aktif). */
  const c = await paced("Siapa saja seller?");
  baseChecks(`${role} C daftar seller`, c);
  noProducts(`${role} C`, c);
  notPii(`${role} C`, c, me);
  const visSellers = gt.users.filter(
    (u) => u.role === "SELLER" && u.isActive && (!u.store || u.store.isActive),
  );
  check(
    new RegExp(`Daftar penjual \\(${numPart(visSellers.length)}\\)`).test(c.reply),
    `${role} C: header "Daftar penjual (${visSellers.length})" (publik)`,
    c.reply.slice(0, 200),
  );
  hasListedNames(`${role} C`, c.reply, visSellers.map((u) => u.name));
}

async function main() {
  console.log(`Target: ${BASE}`);

  /* Ground truth database (query langsung — bukan karangan) --------------- */
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  const users = (await prisma.user.findMany({
    select: {
      name: true,
      role: true,
      isActive: true,
      store: { select: { storeName: true, isActive: true } },
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  })) as UserRow[];
  const byRole: Record<string, number> = {};
  for (const u of users) byRole[u.role] = (byRole[u.role] ?? 0) + 1;
  const pancing = await prisma.store.findFirst({
    where: { storeName: { contains: "pancing", mode: "insensitive" } },
    select: { storeName: true, user: { select: { name: true } } },
  });
  const gt: GT = {
    users,
    byRole,
    total: users.length,
    pancing: pancing ? { storeName: pancing.storeName, owner: pancing.user.name } : null,
  };

  console.log(
    `Ground truth: total=${gt.total} ` +
      `ADMIN=${gt.byRole.ADMIN ?? 0} SELLER=${gt.byRole.SELLER ?? 0} BUYER=${gt.byRole.BUYER ?? 0} ` +
      `aktif=${users.filter((u) => u.isActive).length} belum-aktif=${users.filter((u) => !u.isActive).length}`,
  );
  console.log(
    `Pancing: ${gt.pancing ? `${gt.pancing.storeName} → ${gt.pancing.owner}` : "TIDAK ADA"}`,
  );

  const admin = await login("admin@mendungtirta.com");
  const seller = await login("nelayan.budi@mendungtirta.com");
  const buyer = await login("pembeli@mendungtirta.com");
  console.log("Login BUYER/SELLER/ADMIN: OK");

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

  header("7 uji identitas pengguna × ground truth DB (paralel antar peran)");
  await Promise.all([
    runAdmin(admin, adminMe, gt),
    runRole("SELLER", seller, sellerMe, gt),
    runRole("BUYER", buyer, buyerMe, gt),
  ]);

  await prisma.$disconnect();

  /* Ringkasan ------------------------------------------------------------- */
  console.log(`\n=== RINGKASAN: ${pass} lulus, ${fail} gagal ===`);
  if (fail > 0) {
    console.log("Gagal:");
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exitCode = 1;
  } else {
    console.log("SEMUA UJI IDENTITAS PENGGUNA LULUS ✔");
    process.exitCode = 0;
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

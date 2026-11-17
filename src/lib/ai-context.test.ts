import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectCountQuery,
  detectIntents,
  fetchOrders,
  fetchProductBuyers,
  fetchProductExtremes,
  fetchRevenue,
  fetchRolesSection,
  fetchStoreInfo,
  fetchStoreOwner,
  fetchStoreRank,
  formatCountAnswer,
  queryCountData,
} from "@/lib/ai-context";
import { prisma } from "@/lib/prisma";
import type { SafeUser } from "@/lib/auth";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    product: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    store: { count: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    order: { count: vi.fn(), findMany: vi.fn() },
    orderItem: { findMany: vi.fn() },
    payment: { count: vi.fn() },
    review: { count: vi.fn(), aggregate: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

const makeUser = (role: SafeUser["role"]): SafeUser => ({
  id: `u-${role.toLowerCase()}`,
  name: "Tester",
  email: "tester@example.com",
  role,
  address: null,
  createdAt: new Date("2026-01-01"),
  telegramChatId: null,
  telegramNotify: false,
  telegramLinkedAt: null,
});

describe("detectIntents (AI context routing)", () => {
  it("mendeteksi intent 'order' untuk pertanyaan pesanan", () => {
    expect(detectIntents("status pesanan saya")).toContain("order");
    expect(detectIntents("pembelian kemarin")).toContain("order");
    expect(detectIntents("bayar order")).toContain("order");
    expect(detectIntents("dikirim kapan")).toContain("order");
  });

  it("mendeteksi intent 'sales' untuk pertanyaan penjualan", () => {
    expect(detectIntents("penjualan toko saya")).toContain("sales");
    expect(detectIntents("omzet bulan ini")).toContain("sales");
    expect(detectIntents("pendapatan toko")).toContain("sales");
  });

  it("mendeteksi intent 'stats' untuk rekap/statistik umum", () => {
    expect(detectIntents("statistik marketplace")).toContain("stats");
    expect(detectIntents("tampilkan rekap performa platform")).toContain("stats");
    // Hitungan per entitas BUKAN statistik umum (dideteksi intent 'count').
    expect(detectIntents("jumlah pengguna platform")).not.toContain("stats");
    expect(detectIntents("jumlah pengguna platform")).toContain("count");
  });

  it("mendeteksi intent 'product' untuk pertanyaan produk", () => {
    expect(detectIntents("berapa harga joran tegek")).toContain("product");
    expect(detectIntents("produk apa yang tersedia")).toContain("product");
    expect(detectIntents("cari umpan untuk casting")).toContain("product");
    expect(detectIntents("apakah umpan minnow masih ada")).toContain("product");
    expect(detectIntents("kategori apa saja yang ada")).toContain("product");
  });

  it("mendeteksi intent 'appinfo' untuk pertanyaan layanan/panduan", () => {
    expect(detectIntents("apa saja layanan mendung tirta")).toContain("appinfo");
    expect(detectIntents("tentang kami dong")).toContain("appinfo");
    expect(detectIntents("gimana cara belanja")).toContain("appinfo");
    expect(detectIntents("cara mendaftar gimana")).toContain("appinfo");
    expect(detectIntents("faq apa saja")).toContain("appinfo");
  });

  it("pertanyaan jumlah penjual/pembeli/toko → intent 'count', BUKAN 'stats'", () => {
    for (const q of ["berapa jumlah penjual", "berapa jumlah pembeli", "jumlah toko aktif berapa"]) {
      expect(detectIntents(q)).toContain("count");
      expect(detectIntents(q)).not.toContain("stats");
    }
  });

  it("mendeteksi intent 'lowstock' untuk pertanyaan stok menipis", () => {
    expect(detectIntents("stok menipis")).toContain("lowstock");
    expect(detectIntents("stok hampir habis")).toContain("lowstock");
  });

  it("mendeteksi intent 'outofstock' untuk pertanyaan produk habis", () => {
    expect(detectIntents("produk apa yang habis")).toContain("outofstock");
    expect(detectIntents("stok habis semua")).toContain("outofstock");
    expect(detectIntents("jualannya sudah out of stock")).toContain("outofstock");
    expect(detectIntents("umpan mana yang sold out")).toContain("outofstock");
    expect(detectIntents("stok 0")).toContain("outofstock");
  });

  it("'hampir habis' = stok menipis, bukan habis", () => {
    const intents = detectIntents("stok hampir habis");
    expect(intents).toContain("lowstock");
    expect(intents).not.toContain("outofstock");
  });

  it("mendeteksi intent 'store' untuk pertanyaan toko", () => {
    expect(detectIntents("toko di surabaya")).toContain("store");
    expect(detectIntents("penjualnya siapa")).toContain("store");
  });

  it("mendeteksi intent 'account' untuk pertanyaan informasi akun", () => {
    expect(detectIntents("siapa saya")).toContain("account");
    expect(detectIntents("akun saya")).toContain("account");
    expect(detectIntents("profil saya")).toContain("account");
    expect(detectIntents("informasi akun")).toContain("account");
    expect(detectIntents("nama saya apa")).toContain("account");
    expect(detectIntents("email saya")).toContain("account");
    expect(detectIntents("login sebagai apa")).toContain("account");
    expect(detectIntents("kapan saya daftar")).toContain("account");
    expect(detectIntents("bergabung sejak")).toContain("account");
    expect(detectIntents("role saya")).toContain("account");
    expect(detectIntents("peran saya")).toContain("account");
    expect(detectIntents("ubah profil")).toContain("account");
    expect(detectIntents("ganti profil")).toContain("account");
    expect(detectIntents("edit profil")).toContain("account");
  });

  it("bisa mendeteksi multiple intent sekaligus", () => {
    const intents = detectIntents("siapa saya dan status pesanan saya");
    expect(intents).toContain("account");
    expect(intents).toContain("order");
  });

  it("case-insensitive", () => {
    expect(detectIntents("SIAPA SAYA")).toContain("account");
    expect(detectIntents("AkUn SaYa")).toContain("account");
  });

  it("tidak mendeteksi intent account untuk pertanyaan tidak relevan", () => {
    expect(detectIntents("joran bagus untuk pemula")).not.toContain("account");
    expect(detectIntents("harga ikan segar")).not.toContain("account");
  });
});

/* ------------------------------------------------------------------ */
/* detectCountQuery — variasi bahasa Indonesia untuk hitungan per entitas */
/* ------------------------------------------------------------------ */

describe("detectCountQuery — variasi bahasa Indonesia (hitungan per entitas)", () => {
  it("penjual/seller → hitungan akun penjual (role SELLER)", () => {
    for (const q of [
      "Berapa jumlah penjual?",
      "Ada berapa penjual?",
      "Jumlah seller berapa?",
      "Berapa seller yang terdaftar?",
    ]) {
      expect(detectCountQuery(q)).toEqual(["seller"]);
    }
  });

  it("'toko terdaftar' → hitungan toko (tabel Store), bukan akun penjual", () => {
    expect(detectCountQuery("Ada berapa toko terdaftar?")).toEqual(["store"]);
    expect(detectCountQuery("Jumlah toko aktif berapa?")).toEqual(["store"]);
  });

  it("pembeli/buyer → hitungan pembeli", () => {
    for (const q of [
      "Berapa jumlah pembeli?",
      "Ada berapa pembeli?",
      "Jumlah buyer berapa?",
      "Berapa buyer yang terdaftar?",
    ]) {
      expect(detectCountQuery(q)).toEqual(["buyer"]);
    }
  });

  it("admin → hitungan admin", () => {
    expect(detectCountQuery("Berapa jumlah admin?")).toEqual(["admin"]);
    expect(detectCountQuery("Ada berapa admin terdaftar?")).toEqual(["admin"]);
  });

  it("pengguna/akun → hitungan seluruh pengguna", () => {
    expect(detectCountQuery("Berapa jumlah pengguna?")).toEqual(["user"]);
    expect(detectCountQuery("Ada berapa pengguna terdaftar?")).toEqual(["user"]);
    expect(detectCountQuery("Jumlah seluruh pengguna berapa?")).toEqual(["user"]);
    expect(detectCountQuery("Berapa jumlah akun terdaftar?")).toEqual(["user"]);
  });

  it("produk → hitungan tersedia / habis / total sesuai kata kunci", () => {
    expect(detectCountQuery("Berapa produk yang tersedia?")).toEqual(["availableProducts"]);
    expect(detectCountQuery("Ada berapa produk yang habis?")).toEqual(["outOfStockProducts"]);
    expect(detectCountQuery("Ada berapa produk?")).toEqual(["totalProducts"]);
    // Minta DAFTAR → bukan hitungan (dijawab daftar produk).
    expect(detectCountQuery("Apa saja produk yang tersedia?")).toEqual([]);
  });

  it("pesanan → hitungan pesanan (cakupan mengikuti peran)", () => {
    expect(detectCountQuery("Berapa jumlah pesanan saya?")).toEqual(["orders"]);
    expect(detectCountQuery("Ada berapa pesanan pending?")).toEqual(["orders"]);
  });

  it("pertanyaan milik sendiri bukan hitungan global", () => {
    expect(detectCountQuery("Berapa akun saya?")).toEqual([]); // → profil akun, bukan total pengguna
    expect(detectCountQuery("Berapa pesanan saya?")).toEqual(["orders"]); // tetap hitungan (scoping per peran)
  });

  it("'penjualan' (omzet) bukan hitungan penjual; pertanyaan non-hitungan kosong", () => {
    expect(detectCountQuery("Berapa penjualan bulan ini?")).toEqual([]);
    expect(detectCountQuery("Tampilkan statistik marketplace")).toEqual([]);
    expect(detectCountQuery("Berapa harganya?")).toEqual([]);
    expect(detectCountQuery("Berapa stok ikan kerapu?")).toEqual([]); // fokus produk — bukan hitungan agregat
    expect(detectCountQuery("berapa jumlah toko dan penjual")).toEqual(["seller", "store"]);
  });
});

describe("prioritas intent hitungan > statistik umum", () => {
  it("pertanyaan jumlah per entitas → 'count', rekap umum → 'stats'", () => {
    expect(detectIntents("Tampilkan statistik marketplace")).toContain("stats");
    expect(detectIntents("Tampilkan statistik marketplace")).not.toContain("count");
    expect(detectIntents("rekap performa platform")).toContain("stats");
  });
});

/* ------------------------------------------------------------------ */
/* formatCountAnswer — jawaban deterministik HANYA sesuai intent      */
/* ------------------------------------------------------------------ */

describe("formatCountAnswer — jawaban deterministik hanya sesuai intent", () => {
  it("jawaban persis per intent — angka yang diminta saja, bukan ringkasan", () => {
    expect(formatCountAnswer("seller", 3, "Berapa jumlah penjual?", "ADMIN")).toBe(
      "Saat ini terdapat 3 penjual terdaftar di Mendung Tirta.",
    );
    expect(formatCountAnswer("buyer", 26, "Berapa jumlah pembeli?", "ADMIN")).toBe(
      "Saat ini terdapat 26 pembeli terdaftar di Mendung Tirta.",
    );
    expect(formatCountAnswer("user", 30, "Berapa jumlah pengguna?", "ADMIN")).toBe(
      "Saat ini terdapat 30 pengguna terdaftar di Mendung Tirta.",
    );
    expect(formatCountAnswer("admin", 1, "Berapa jumlah admin?", "ADMIN")).toBe(
      "Saat ini terdapat 1 admin terdaftar di Mendung Tirta.",
    );
    expect(formatCountAnswer("availableProducts", 3, "Berapa produk yang tersedia?", "BUYER")).toBe(
      "Saat ini terdapat 3 produk yang tersedia untuk dibeli.",
    );
  });

  it("non-admin TIDAK menerima angka internal — penolakan, bukan 0", () => {
    const r = formatCountAnswer("buyer", null, "Berapa jumlah pembeli?", "BUYER");
    expect(r).toMatch(/hanya tersedia untuk admin/);
    expect(r).not.toMatch(/\b0\b/);
    expect(formatCountAnswer("user", null, "Berapa jumlah pengguna?", "SELLER")).toMatch(/internal/);
  });

  it("hitungan pesanan mengikuti cakupan per peran + status yang diminta", () => {
    expect(formatCountAnswer("orders", 25, "Berapa jumlah pesanan saya?", "BUYER")).toBe(
      "Anda memiliki 25 pesanan.",
    );
    expect(formatCountAnswer("orders", 4, "Berapa pesanan yang diproses?", "ADMIN")).toBe(
      "Terdapat 4 pesanan di marketplace berstatus Diproses.",
    );
    expect(formatCountAnswer("orders", 6, "Jumlah pesanan toko saya?", "SELLER")).toBe(
      "Toko Anda memiliki 6 pesanan.",
    );
  });

  it("toko: membedakan total terdaftar vs aktif sesuai pertanyaan", () => {
    expect(formatCountAnswer("store", 3, "Ada berapa toko terdaftar?", "BUYER")).toBe(
      "Saat ini terdapat 3 toko terdaftar di Mendung Tirta.",
    );
    expect(formatCountAnswer("store", 2, "Jumlah toko aktif berapa?", "BUYER")).toBe(
      "Saat ini terdapat 2 toko aktif di Mendung Tirta.",
    );
  });
});

/* ------------------------------------------------------------------ */
/* queryCountData — query aktual, otorisasi peran, error ≠ 0           */
/* ------------------------------------------------------------------ */

describe("queryCountData — query aktual & error tidak menjadi angka 0", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mengambil nilai dari DB sesuai intent (penjual = akun role SELLER)", async () => {
    vi.mocked(prisma.user.count).mockResolvedValueOnce(3);
    const v = await queryCountData(makeUser("ADMIN"), "seller", "Berapa jumlah penjual?");
    expect(v).toBe(3);
    expect(prisma.user.count).toHaveBeenCalledWith({ where: { role: "SELLER" } });
  });

  it("otorisasi: non-admin TIDAK mengambil jumlah pembeli/pengguna (null, bukan 0)", async () => {
    const buyer = makeUser("BUYER");
    await expect(queryCountData(buyer, "buyer", "Berapa jumlah pembeli?")).resolves.toBeNull();
    await expect(queryCountData(buyer, "user", "Berapa jumlah pengguna?")).resolves.toBeNull();
    await expect(queryCountData(buyer, "admin", "Berapa jumlah admin?")).resolves.toBeNull();
    expect(prisma.user.count).not.toHaveBeenCalled(); // tidak ada query yang membocorkan angka
  });

  it("error database DITOLAK (throw) — tidak pernah diubah menjadi angka 0", async () => {
    vi.mocked(prisma.user.count).mockRejectedValueOnce(new Error("db down"));
    await expect(
      queryCountData(makeUser("ADMIN"), "seller", "Berapa jumlah penjual?"),
    ).rejects.toThrow("db down");
  });
});

/* ------------------------------------------------------------------ */
/* Intent filter harga & hitungan berfilter subjek                     */
/* ------------------------------------------------------------------ */

describe("intent produk dari filter harga & hitungan berfilter subjek", () => {
  it("'di bawah 50000' / 'di atas 50000' (tanpa kata 'produk') → intent product", () => {
    expect(detectIntents("di bawah 50000").has("product")).toBe(true);
    expect(detectIntents("di atas 50000").has("product")).toBe(true);
    expect(detectIntents("umpan di bawah 75000").has("product")).toBe(true);
  });

  it("'berapa jumlah produk hasil laut?' → hitungan totalProducts (bukan listing/istirahat)", () => {
    expect(detectCountQuery("berapa jumlah produk hasil laut?")).toEqual(["totalProducts"]);
    expect(detectIntents("berapa jumlah produk hasil laut?").has("count")).toBe(true);
  });

  it("hitungan dengan subjek DAN filter harga tetap intent count (bukan pencarian biasa)", () => {
    const intents = detectIntents("berapa jumlah produk hasil laut di bawah 50000?");
    expect(intents.has("count")).toBe(true);
    expect(detectCountQuery("berapa jumlah produk hasil laut di bawah 50000?")).toEqual([
      "totalProducts",
    ]);
  });

  it("pertanyaan atribut produk tetap bukan hitungan", () => {
    expect(detectCountQuery("berapa harga ikan kerapu?")).toEqual([]);
    expect(detectCountQuery("berapa stok ikan kerapu?")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* fetchRolesSection — jumlah pengguna per role (COUNT real-time)      */
/* ------------------------------------------------------------------ */

describe("fetchRolesSection — jumlah pengguna per role pada USER_ROLES", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("USER_ROLES → angka per role dari DB + total = penjumlahan, tanpa PII", async () => {
    vi.mocked(prisma.user.groupBy).mockResolvedValue([
      { role: "ADMIN", _count: { _all: 1 } },
      { role: "SELLER", _count: { _all: 2 } },
      { role: "BUYER", _count: { _all: 9 } },
    ] as never);
    const s = await fetchRolesSection(
      makeUser("ADMIN"),
      "USER_ROLES",
      "Ada apa saja role pengguna?",
    );
    expect(s.key).toBe("roles");
    expect(s.text).toContain("1. ADMIN: 1");
    expect(s.text).toContain("2. SELLER (Penjual): 2");
    expect(s.text).toContain("3. BUYER (Pembeli): 9");
    expect(s.text).toContain("4. Total pengguna: 12"); // 1 + 2 + 9
    expect(s.text).not.toMatch(/@/); // tanpa email
    expect(s.text).not.toMatch(/\bEmail:/);
    expect(s.text).not.toMatch(/\bNama:/);
    expect(prisma.user.groupBy).toHaveBeenCalledTimes(1);
  });

  it("angka dinamis dari query — total selalu dihitung ulang, bukan angka tetap", async () => {
    vi.mocked(prisma.user.groupBy).mockResolvedValue([
      { role: "ADMIN", _count: { _all: 3 } },
      { role: "SELLER", _count: { _all: 4 } },
      { role: "BUYER", _count: { _all: 6 } },
    ] as never);
    const s = await fetchRolesSection(
      makeUser("BUYER"),
      "USER_ROLES",
      "Ada apa saja role pengguna?",
    );
    expect(s.text).toContain("1. ADMIN: 3");
    expect(s.text).toContain("4. Total pengguna: 13"); // 3 + 4 + 6, dihitung ulang
    expect(s.text).not.toContain("4. Total pengguna: 12"); // bukan angka runtunan tes sebelumnya
  });

  it("DB gagal → pesan 'statistik belum tersedia', tanpa angka karangan, definisi role tetap ada", async () => {
    vi.mocked(prisma.user.groupBy).mockRejectedValue(new Error("db down"));
    const s = await fetchRolesSection(
      makeUser("SELLER"),
      "USER_ROLES",
      "Ada apa saja role pengguna?",
    );
    expect(s.text).toMatch(/Statistik jumlah pengguna per role belum tersedia/i);
    expect(s.text).not.toMatch(/Total pengguna:/);
    expect(s.text).not.toMatch(/\d+\. ADMIN:/);
    expect(s.text).toContain("ADMIN (Administrator)"); // info aplikasi statis tetap dijawab
  });

  it("ROLE_PERMISSION tetap fokus hak akses — tanpa jumlah pengguna (tanpa query)", async () => {
    const s = await fetchRolesSection(makeUser("ADMIN"), "ROLE_PERMISSION", "Apa tugas admin?");
    expect(s.text).toContain("Hak akses ADMIN (Administrator)");
    expect(s.text).not.toContain("Jumlah pengguna per role");
    expect(prisma.user.groupBy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* fetchRolesSection — USER_LIST daftar per role (hak akses)           */
/* ------------------------------------------------------------------ */

describe("fetchRolesSection — USER_LIST daftar penjual/toko (info publik)", () => {
  const sellers = [
    {
      name: "Budi Santoso",
      isActive: true,
      store: { id: "s1", storeName: "Hasil Laut Pak Budi", isActive: true, _count: { products: 2 } },
    },
    {
      name: "Citra Lestari",
      isActive: true,
      store: { id: "s2", storeName: "Pancing Jaya", isActive: true, _count: { products: 1 } },
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("semua peran melihat nama, toko, status, jumlah produk — tanpa email/PII", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue(sellers as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([
      { storeId: "s1", _count: { _all: 1 } },
    ] as never);
    for (const role of ["BUYER", "SELLER", "ADMIN"] as const) {
      const s = await fetchRolesSection(makeUser(role), "USER_LIST", "Siapa saja seller?");
      expect(s.key).toBe("userlist");
      expect(s.scope).toBe(role === "ADMIN" ? "admin" : "publik");
      expect(s.text).toContain("Budi Santoso");
      expect(s.text).toContain("Hasil Laut Pak Budi");
      expect(s.text).toContain("Akun: Aktif");
      expect(s.text).toContain("Toko: Hasil Laut Pak Budi (Aktif)");
      expect(s.text).toContain("Produk: 2 (1 tersedia)");
      expect(s.text).toContain("Produk: 1 (0 tersedia)");
      expect(s.text).not.toMatch(/@/);
      expect(s.text).not.toMatch(/\bEmail\b/i);
    }
    // 1 query daftar + 1 query groupBy produk tersedia per pemanggilan.
    expect(prisma.user.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.product.groupBy).toHaveBeenCalledTimes(3);
  });

  it("BUYER/SELLER → hanya penjual ber-akun-aktif dengan toko aktif (atau tanpa toko)", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue(sellers as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([] as never);
    const expectedWhere = {
      role: "SELLER",
      isActive: true,
      OR: [{ store: null }, { store: { isActive: true } }],
    };
    await fetchRolesSection(makeUser("BUYER"), "USER_LIST", "Siapa saja seller?");
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    await fetchRolesSection(makeUser("SELLER"), "USER_LIST", "Siapa saja penjual?");
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
  });

  it("ADMIN → data lengkap (seluruh penjual, termasuk nonaktif)", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue(sellers as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([] as never);
    await fetchRolesSection(makeUser("ADMIN"), "USER_LIST", "Siapa saja seller?");
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "SELLER" } }),
    );
  });

  it("'produk tersedia' → hanya penjual dengan produk AVAILABLE & stok > 0", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue(sellers as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([] as never);
    await fetchRolesSection(
      makeUser("BUYER"),
      "USER_LIST",
      "Tampilkan seller yang memiliki produk tersedia.",
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: "SELLER",
          isActive: true,
          store: { isActive: true, products: { some: { status: "AVAILABLE", stock: { gt: 0 } } } },
        },
      }),
    );
  });

  it("daftar pembeli/pengguna → hanya admin (penolakan jujur, tanpa query & nama)", async () => {
    const r = await fetchRolesSection(makeUser("BUYER"), "USER_LIST", "Siapa saja buyer?");
    expect(r.text).toMatch(/hanya dapat dilihat oleh admin/);
    expect(r.text).not.toMatch(/@/);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.user.groupBy).not.toHaveBeenCalled();

    vi.mocked(prisma.user.groupBy).mockResolvedValue([
      { role: "BUYER", _count: { _all: 1 } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { name: "Pembeli Satu", isActive: true, store: null },
    ] as never);
    const a = await fetchRolesSection(makeUser("ADMIN"), "USER_LIST", "Siapa saja buyer?");
    expect(a.label).toBe("Daftar pembeli (1 akun)");
    expect(a.text).toContain("Nama pembeli: Pembeli Satu");
    expect(a.text).toContain("Status: Aktif");
    expect(a.text).toContain("Total pembeli: 1.");
    expect(a.text).not.toMatch(/@/);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { role: "BUYER" } }),
    );
  });

  it("daftar pengguna (ALL) → dikelompokkan ADMIN/SELLER/BUYER + jumlah per role", async () => {
    vi.mocked(prisma.user.groupBy).mockResolvedValue([
      { role: "ADMIN", _count: { _all: 1 } },
      { role: "SELLER", _count: { _all: 2 } },
      { role: "BUYER", _count: { _all: 9 } },
    ] as never);
    vi.mocked(prisma.user.findMany)
      .mockResolvedValueOnce([
        { name: "Admin Satu", isActive: true, store: null },
      ] as never)
      .mockResolvedValueOnce([
        { name: "Budi", isActive: true, store: { storeName: "Toko Budi", isActive: true } },
        { name: "Citra", isActive: false, store: null },
      ] as never)
      .mockResolvedValueOnce([
        { name: "Dedi", isActive: true, store: null },
      ] as never);
    const s = await fetchRolesSection(makeUser("ADMIN"), "USER_LIST", "Siapa saja pengguna?");
    expect(s.label).toBe("Daftar pengguna (12 akun)");
    expect(s.text).toContain(
      "Total pengguna: 12 — ADMIN: 1, SELLER (Penjual): 2, BUYER (Pembeli): 9.",
    );
    expect(s.text).toContain("ADMIN (1):");
    expect(s.text).toContain("SELLER (2):");
    expect(s.text).toContain("BUYER (9):");
    expect(s.text).toContain("1. Nama admin: Admin Satu — Status: Aktif");
    expect(s.text).toContain("Toko: Toko Budi (Aktif)");
    expect(s.text).toContain("Toko: -");
    expect(s.text).toContain("Status: Nonaktif");
    expect(s.text).toContain("Nama pembeli: Dedi");
    expect(s.text).not.toMatch(/@/); // tanpa email/PII
    expect(s.text).not.toMatch(/\bEmail:/);
    // 1 groupBy (jumlah per role) + 3 findMany (satu per role di halaman ini).
    expect(prisma.user.groupBy).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(3);
  });

  it("filter status eksplisit ('yang aktif') → where + label ikut tersaring", async () => {
    vi.mocked(prisma.user.groupBy).mockResolvedValue([
      { role: "SELLER", _count: { _all: 2 } },
    ] as never);
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { name: "Budi", isActive: true, store: null },
    ] as never);
    const s = await fetchRolesSection(
      makeUser("ADMIN"),
      "USER_LIST",
      "Siapa saja pengguna yang aktif?",
    );
    expect(s.label).toBe("Daftar pengguna aktif (2 akun)");
    expect(prisma.user.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, role: "SELLER" } }),
    );
    expect(s.text).toContain("Total pengguna: 2");
  });

  it("halaman di luar jangkauan → jujur, tanpa query baris & tanpa angka karangan", async () => {
    vi.mocked(prisma.user.groupBy).mockResolvedValue([
      { role: "BUYER", _count: { _all: 5 } },
    ] as never);
    const s = await fetchRolesSection(
      makeUser("ADMIN"),
      "USER_LIST",
      "Tampilkan daftar pengguna halaman 9",
    );
    expect(s.text).toContain("Halaman 9 tidak tersedia");
    expect(s.text).toContain('Tanyakan "halaman 1"');
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("data kosong → 'Belum ada … terdaftar' jujur (bukan 0, bukan karangan)", async () => {
    vi.mocked(prisma.user.groupBy).mockResolvedValue([] as never);
    const s = await fetchRolesSection(makeUser("ADMIN"), "USER_LIST", "Siapa saja pengguna?");
    expect(s.label).toBe("Daftar pengguna");
    expect(s.text).toBe("Belum ada pengguna terdaftar di Mendung Tirta.");
    expect(s.text).not.toMatch(/\b0\b/);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("DB gagal saat groupBy → error mengendap (bukan 'data tidak ditemukan')", async () => {
    vi.mocked(prisma.user.groupBy).mockRejectedValue(new Error("db down"));
    await expect(
      fetchRolesSection(makeUser("ADMIN"), "USER_LIST", "Siapa saja pengguna?"),
    ).rejects.toThrow("db down");
  });

  it("data kosong → 'Belum ada … terdaftar' (bukan angka 0, bukan data lain)", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([] as never);
    const s = await fetchRolesSection(makeUser("BUYER"), "USER_LIST", "Siapa saja seller?");
    expect(s.text).toBe("Belum ada penjual terdaftar di Mendung Tirta.");
    expect(s.text).not.toMatch(/\b0\b/);
  });

  it("DB gagal → error mengendap ke route (bukan 'data tidak ditemukan', bukan angka)", async () => {
    vi.mocked(prisma.user.findMany).mockRejectedValue(new Error("db down"));
    await expect(
      fetchRolesSection(makeUser("BUYER"), "USER_LIST", "Siapa saja seller?"),
    ).rejects.toThrow("db down");
  });
});

/* ------------------------------------------------------------------ */
/* fetchStoreInfo — "Siapa penjual ikan kerapu?" → pemilik produk      */
/* ------------------------------------------------------------------ */

describe("fetchStoreInfo — penjual dari subjek produk (STORE_INFO)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("subjek produk → penjual/toko pemilik dari DB (tanpa PII)", async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      {
        name: "Ikan Kerapu Macan Segar",
        store: {
          id: "s1",
          storeName: "Hasil Laut Pak Budi",
          isActive: true,
          user: { name: "Budi Santoso", isActive: true },
          _count: { products: 2 },
        },
      },
    ] as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([
      { storeId: "s1", _count: { _all: 1 } },
    ] as never);

    const s = await fetchStoreInfo("Siapa penjual ikan kerapu?", ["ikan", "kerapu"]);
    expect(s).not.toBeNull();
    expect(s!.key).toBe("store");
    expect(s!.text).toContain("Budi Santoso");
    expect(s!.text).toContain("Hasil Laut Pak Budi");
    expect(s!.text).toContain("Akun: Aktif");
    expect(s!.text).toContain("(1 tersedia)");
    expect(s!.text).toContain("Ikan Kerapu Macan Segar");
    expect(s!.text).not.toMatch(/@/);
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: "ikan kerapu", mode: "insensitive" },
        }),
      }),
    );
  });

  it("tanpa frasa subjek → jalur profil toko biasa (fetchStores)", async () => {
    vi.mocked(prisma.store.findMany).mockResolvedValue([
      {
        storeName: "Hasil Laut Pak Budi",
        location: "Tual",
        description: null,
        _count: { products: 2 },
      },
    ] as never);
    const s = await fetchStoreInfo("Info toko ini dong", []);
    expect(s).not.toBeNull();
    expect(s!.text).toContain("Hasil Laut Pak Budi");
    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it("subjek tanpa produk cocok → null (dilanjutkan ke fetchStores, hasil kosong jujur)", async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.store.findMany).mockResolvedValue([] as never);
    const s = await fetchStoreInfo("Siapa penjual perahu roket?", ["perahu", "roket"]);
    expect(s).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Domain data baru — pemilik toko, peringkat toko, ekstrem harga,     */
/* pembeli per produk, cakupan pesanan admin, periode pendapatan,      */
/* hitungan Payment (PAID) & Review (COUNT/AVG)                        */
/* ------------------------------------------------------------------ */

describe("queryCountData — kind baru (Payment PAID & Review) sesuai peran", () => {
  beforeEach(() => vi.clearAllMocks());

  it("paidPayments: ADMIN global — dari tabel Payment (bukan orders)", async () => {
    vi.mocked(prisma.payment.count).mockResolvedValue(7 as never);
    const n = await queryCountData(makeUser("ADMIN"), "paidPayments", "Berapa transaksi berhasil?");
    expect(n).toBe(7);
    expect(prisma.payment.count).toHaveBeenCalledWith({ where: { status: "PAID" } });
  });

  it("paidPayments: BUYER hanya pembayaran milik sendiri (scoping peran)", async () => {
    vi.mocked(prisma.payment.count).mockResolvedValue(3 as never);
    const n = await queryCountData(makeUser("BUYER"), "paidPayments", "Berapa transaksi berhasil?");
    expect(n).toBe(3);
    expect(prisma.payment.count).toHaveBeenCalledWith({
      where: { status: "PAID", order: { buyerId: "u-buyer" } },
    });
  });

  it("paidPayments: SELLER tanpa toko → null (bukan nol karangan)", async () => {
    vi.mocked(prisma.store.findUnique).mockResolvedValue(null as never);
    expect(
      await queryCountData(makeUser("SELLER"), "paidPayments", "Berapa transaksi berhasil?"),
    ).toBeNull();
    expect(prisma.payment.count).not.toHaveBeenCalled();
  });

  it("reviews (COUNT) & avgRating (AVG) — publik untuk semua peran", async () => {
    vi.mocked(prisma.review.count).mockResolvedValue(12 as never);
    expect(await queryCountData(makeUser("BUYER"), "reviews", "Berapa jumlah ulasan?")).toBe(12);

    vi.mocked(prisma.review.aggregate).mockResolvedValue({
      _avg: { rating: 4.3 },
      _count: { _all: 10 },
    } as never);
    expect(await queryCountData(makeUser("BUYER"), "avgRating", "Berapa rating rata-rata?")).toBe(4.3);

    // Tanpa ulasan → 0 (bukan NaN/null karangan — dijawab "Belum ada ulasan").
    vi.mocked(prisma.review.aggregate).mockResolvedValue({
      _avg: { rating: null },
      _count: { _all: 0 },
    } as never);
    expect(await queryCountData(makeUser("ADMIN"), "avgRating", "Berapa rating rata-rata?")).toBe(0);
  });
});

describe("formatCountAnswer — kind baru (angka + pembatasan jujur)", () => {
  it("paidPayments per peran; null → pembatasan jujur", () => {
    expect(formatCountAnswer("paidPayments", 7, "Berapa transaksi berhasil?", "ADMIN")).toContain(
      "7 pembayaran yang berhasil",
    );
    expect(formatCountAnswer("paidPayments", 0, "Berapa transaksi berhasil?", "BUYER")).toBe(
      "Anda belum memiliki pembayaran yang berhasil.",
    );
    expect(formatCountAnswer("paidPayments", 5, "Berapa transaksi berhasil?", "BUYER")).toContain(
      "5 pembayaran",
    );
    expect(formatCountAnswer("paidPayments", null, "Berapa transaksi berhasil?", "SELLER")).toContain(
      "Toko Anda belum terdaftar",
    );
  });

  it("reviews & avgRating — jujur bila 0 data", () => {
    expect(formatCountAnswer("reviews", 12, "Berapa jumlah ulasan?", "BUYER")).toContain(
      "12 ulasan",
    );
    expect(formatCountAnswer("reviews", 0, "Berapa jumlah ulasan?", "BUYER")).toMatch(
      /Belum ada ulasan/,
    );
    expect(formatCountAnswer("avgRating", 4.3, "Berapa rating rata-rata?", "BUYER")).toContain(
      "4.3 dari 5",
    );
    expect(formatCountAnswer("avgRating", 0, "Berapa rating rata-rata?", "BUYER")).toMatch(
      /Belum ada ulasan/,
    );
  });
});

describe("fetchStoreOwner — \"Siapa pemilik toko …?\" (publik, tanpa PII)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("nama toko cocok → nama pemilik + status + jumlah produk (tanpa email)", async () => {
    vi.mocked(prisma.store.findFirst).mockResolvedValue({
      id: "s1",
      storeName: "Toko Pancing Jaya Abadi",
      location: "Tual",
      isActive: true,
      user: { name: "Budi Santoso", isActive: true },
      _count: { products: 4 },
    } as never);
    vi.mocked(prisma.product.count).mockResolvedValue(3 as never);

    const s = await fetchStoreOwner("Siapa pemilik toko Pancing Jaya Abadi?");
    expect(s).not.toBeNull();
    expect(s!.text).toContain("Pemilik toko Toko Pancing Jaya Abadi: Budi Santoso");
    expect(s!.text).toContain("Status toko: Aktif");
    expect(s!.text).toContain("Jumlah produk: 4 (3 tersedia)");
    expect(s!.text).not.toMatch(/@|password/i); // tanpa email/PII
    expect(prisma.store.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeName: { contains: "pancing jaya abadi", mode: "insensitive" } },
      }),
    );
  });

  it("tanpa nama toko → klarifikasi singkat (tanpa query)", async () => {
    const s = await fetchStoreOwner("Siapa pemilik toko?");
    expect(s!.text).toMatch(/Sebutkan nama tokonya/);
    expect(prisma.store.findFirst).not.toHaveBeenCalled();
  });

  it("nama tak ditemukan → penolakan jujur (bukan jawaban generik)", async () => {
    vi.mocked(prisma.store.findFirst).mockResolvedValue(null as never);
    const s = await fetchStoreOwner("Siapa pemilik toko Ga Ada Banget?");
    expect(s!.text).toMatch(/tidak ditemukan/);
  });

  it("bukan pertanyaan pemilik → null (lanjut rantai STORE_INFO)", async () => {
    expect(await fetchStoreOwner("Info toko ini dong")).toBeNull();
    expect(prisma.store.findFirst).not.toHaveBeenCalled();
  });
});

describe("fetchStoreRank — \"Toko mana yang paling banyak produk?\" (agregasi DB)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("peringkat dari COUNT per toko + jumlah tersedia + pemilik", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { id: "s1", storeName: "Toko A", owner: "Andi", total: 5 },
      { id: "s2", storeName: "Toko B", owner: "Budi", total: 2 },
    ] as never);
    vi.mocked(prisma.product.groupBy).mockResolvedValue([
      { storeId: "s1", _count: { _all: 4 } },
    ] as never);

    const s = await fetchStoreRank();
    expect(s.scope).toBe("publik");
    expect(s.label).toMatch(/terbanyak/);
    expect(s.text).toContain("1. Toko A — 5 produk (4 tersedia) — pemilik: Andi");
    expect(s.text).toContain("2. Toko B — 2 produk (0 tersedia) — pemilik: Budi");
    expect(prisma.product.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ storeId: { in: ["s1", "s2"] } }) }),
    );
  });

  it("tanpa toko aktif → pesan jujur", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([] as never);
    const s = await fetchStoreRank();
    expect(s.text).toMatch(/Belum ada toko aktif/);
  });
});

describe("fetchProductExtremes — MIN/MAX harga aktual", () => {
  beforeEach(() => vi.clearAllMocks());

  it("termahal & termurah dari DB — lengkap dengan stok/kategori/toko", async () => {
    vi.mocked(prisma.product.findFirst)
      .mockResolvedValueOnce({
        name: "Ikan Kerapu Premium",
        price: 125000,
        stock: 2,
        status: "AVAILABLE",
        category: { name: "Hasil Laut" },
        store: { storeName: "Toko A" },
      } as never)
      .mockResolvedValueOnce({
        name: "Umpan Jigar",
        price: 5000,
        stock: 40,
        status: "AVAILABLE",
        category: { name: "Umpan" },
        store: { storeName: "Toko B" },
      } as never);

    const s = await fetchProductExtremes();
    expect(s.key).toBe("extremes");
    expect(s.scope).toBe("publik");
    expect(s.text).toContain("Termahal: Ikan Kerapu Premium — Rp125.000");
    expect(s.text).toContain("Termurah: Umpan Jigar — Rp5.000");
    expect(s.text).toContain("stok 2");
    expect(s.text).toContain("kategori Hasil Laut");
  });
});

describe("fetchProductBuyers — pembeli per produk + otorisasi per peran", () => {
  beforeEach(() => vi.clearAllMocks());

  it("BUYER ditolak TANPA query sama sekali (data internal)", async () => {
    const s = await fetchProductBuyers(
      makeUser("BUYER"),
      "Siapa pembeli yang memesan ikan kerapu?",
    );
    expect(s.text).toMatch(/admin/);
    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("ADMIN → daftar pembeli + total unit + pesanan terakhir (tanpa PII lain)", async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      { id: "p1", name: "Ikan Kerapu Macan Segar (1 Kg)", store: { userId: "u-seller" } },
    ] as never);
    vi.mocked(prisma.orderItem.findMany).mockResolvedValue([
      {
        quantity: 2,
        order: {
          id: "abcd1234efgh",
          status: "COMPLETED",
          createdAt: new Date("2026-11-01T10:00:00Z"),
          buyer: { id: "b1", name: "Andi Kurniawan" },
        },
      },
      {
        quantity: 1,
        order: {
          id: "abcd1234efgh",
          status: "COMPLETED",
          createdAt: new Date("2026-11-01T10:00:00Z"),
          buyer: { id: "b1", name: "Andi Kurniawan" },
        },
      },
      {
        quantity: 3,
        order: {
          id: "ffff9999zzzz",
          status: "PROCESSING",
          createdAt: new Date("2026-11-05T09:00:00Z"),
          buyer: { id: "b2", name: "Siti Aminah" },
        },
      },
    ] as never);

    const s = await fetchProductBuyers(
      makeUser("ADMIN"),
      "Siapa pembeli yang memesan ikan kerapu?",
    );
    expect(s.scope).toBe("admin");
    expect(s.label).toContain("Ikan Kerapu");
    expect(s.text).toContain("Andi Kurniawan — total 3 unit");
    expect(s.text).toContain("Siti Aminah — total 3 unit");
    expect(s.text).toContain("#abcd1234");
    expect(s.text).not.toMatch(/@/); // tanpa email
  });

  it("SELLER + produk toko lain → penolakan jujur, tanpa query pesanan", async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([
      { id: "p9", name: "Kail Pancing Premium", store: { userId: "u-other" } },
    ] as never);
    const s = await fetchProductBuyers(
      makeUser("SELLER"),
      "Siapa pembeli yang memesan kail pancing?",
    );
    expect(s.text).toMatch(/bukan dari toko Anda/);
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("produk tidak ditemukan → penolakan jujur (bukan angka karangan)", async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValue([] as never);
    const s = await fetchProductBuyers(
      makeUser("ADMIN"),
      "Siapa pembeli yang memesan produk ga ada banget?",
    );
    expect(s.text).toMatch(/tidak ditemukan/);
  });
});

describe("fetchOrders — cakupan admin: 'pesanan saya' vs pesanan terbaru", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ADMIN + rujukan 'pesanan saya' → MILIK SENDIRI saja", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      {
        id: "own123456",
        createdAt: new Date(),
        total: 50000,
        status: "PENDING",
        payment: { status: "PENDING" },
        orderItems: [
          { quantity: 1, product: { name: "Ikan Kerapu", store: { storeName: "Toko A" } } },
        ],
      },
    ] as never);
    const s = await fetchOrders(makeUser("ADMIN"), "Bagaimana status pesanan saya?");
    expect(s!.scope).toBe("milik-sendiri");
    expect(s!.label).toContain("Pesanan Anda");
  });

  it("ADMIN tanpa rujukan sendiri → pesanan terbaru SELURUH marketplace + pembeli", async () => {
    vi.mocked(prisma.order.findMany).mockResolvedValue([
      {
        id: "ord12345678",
        createdAt: new Date(),
        total: 75000,
        status: "PROCESSING",
        payment: { status: "PAID" },
        buyer: { name: "Andi Kurniawan" },
        orderItems: [
          { quantity: 2, product: { name: "Cumi Segar", store: { storeName: "Toko B" } } },
        ],
      },
    ] as never);
    const s = await fetchOrders(makeUser("ADMIN"), "Tampilkan pesanan terbaru.");
    expect(s!.scope).toBe("admin");
    expect(s!.label).toContain("seluruh marketplace");
    expect(s!.text).toContain("pembeli: Andi Kurniawan");
    expect(s!.text).toContain("Toko B");
    expect(s!.label).not.toContain("Pesanan Anda");
  });
});

describe("fetchRevenue — filter periode & ranking produk terbesar", () => {
  beforeEach(() => vi.clearAllMocks());

  it("BUYER → penolakan jujur TANPA query database", async () => {
    const s = await fetchRevenue(makeUser("BUYER"), "Berapa total pendapatan?");
    expect(s.text).toMatch(/hanya tersedia untuk admin/);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });

  it("ADMIN 'bulan ini' → nominal dari DB + periode bertanggal", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ total: "1250000" }] as never);
    const s = await fetchRevenue(makeUser("ADMIN"), "Berapa pendapatan bulan ini?");
    expect(s.scope).toBe("admin");
    expect(s.label).toContain("bulan ini");
    expect(s.text).toContain("Rp1.250.000");
    expect(s.text).toContain("pada periode bulan ini");
    expect(s.text).toMatch(/Diproses, Dikirim, Siap Diambil, dan Selesai/);
  });

  it("tanpa periode → frasa lama dipertahankan (regresi teks)", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ total: "999000" }] as never);
    const s = await fetchRevenue(makeUser("ADMIN"), "Berapa total pendapatan?");
    expect(s.text).toContain(
      "pada periode seluruh periode data (sejak awal catatan transaksi).",
    );
    expect(s.label).toBe("Total pendapatan marketplace (data aktual)");
  });

  it("'produk … pendapatan terbesar' → ranking SUM per produk dari DB", async () => {
    vi.mocked(prisma.$queryRaw)
      .mockResolvedValueOnce([{ total: "900000" }] as never)
      .mockResolvedValueOnce([
        { name: "Ikan Kerapu Macan Segar (1 Kg)", rev: "600000", units: "4" },
        { name: "Cumi Segar (500 G)", rev: "300000", units: "6" },
      ] as never);
    const s = await fetchRevenue(
      makeUser("ADMIN"),
      "Produk apa yang menghasilkan pendapatan terbesar?",
    );
    expect(s.text).toContain("Produk dengan pendapatan terbesar:");
    expect(s.text).toContain("1. Ikan Kerapu Macan Segar (1 Kg) — Rp600.000 (4 unit terjual)");
    expect(s.text).toContain("2. Cumi Segar (500 G) — Rp300.000 (6 unit terjual)");
  });
});
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectCountQuery,
  detectIntents,
  formatCountAnswer,
  queryCountData,
} from "@/lib/ai-context";
import { prisma } from "@/lib/prisma";
import type { SafeUser } from "@/lib/auth";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { count: vi.fn() },
    product: { count: vi.fn() },
    store: { count: vi.fn(), findUnique: vi.fn() },
    order: { count: vi.fn() },
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
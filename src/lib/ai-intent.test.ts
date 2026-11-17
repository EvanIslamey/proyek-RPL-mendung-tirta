import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyChatbotIntent,
  detectBuyersOfProduct,
  detectChatbotIntent,
  detectCountQuery,
  detectIntents,
  detectProductExtremes,
  detectUserListTarget,
  mergeIntentParams,
  STORE_RANK_RE,
} from "@/lib/ai-intent";
import {
  CHATBOT_INTENTS,
  NON_CATALOG_INTENTS,
  parseStoreFilter,
  type ChatbotIntent,
  type ProductFilter,
} from "@/lib/ai";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    integrationConfig: { findUnique: vi.fn(async () => null) },
  },
}));

/* ------------------------------------------------------------------ */
/* 1. Taksonomi — 19 kategori + intent non-katalog                     */
/* ------------------------------------------------------------------ */

describe("taksonomi intent chatbot", () => {
  it("memuat tepat 19 kategori wajib", () => {
    expect(CHATBOT_INTENTS).toHaveLength(19);
    for (const c of [
      "PRODUCT_SEARCH", "PRODUCT_PRICE", "PRODUCT_STOCK", "PRODUCT_CATEGORY",
      "REVENUE", "SALES_REPORT", "ORDER_COUNT", "ORDER_STATUS", "USER_COUNT",
      "USER_ROLES", "ROLE_PERMISSION", "USER_LIST",
      "SELLER_INFO", "BUYER_INFO", "MARKETPLACE_STATS", "ACCOUNT_INFO",
      "STORE_INFO", "SERVICE_INFO", "GENERAL",
    ]) {
      expect(CHATBOT_INTENTS).toContain(c as ChatbotIntent);
    }
  });

  it("intent non-katalog tidak pernah dijawab dengan produk", () => {
    for (const c of [
      "REVENUE", "SALES_REPORT", "ORDER_COUNT", "ORDER_STATUS", "USER_COUNT",
      "USER_ROLES", "ROLE_PERMISSION", "USER_LIST",
      "SELLER_INFO", "BUYER_INFO", "MARKETPLACE_STATS", "ACCOUNT_INFO",
      "STORE_INFO", "SERVICE_INFO",
    ]) {
      expect(NON_CATALOG_INTENTS.has(c as ChatbotIntent)).toBe(true);
    }
    // Produk & percakapan umum TETAP boleh memakai katalog.
    expect(NON_CATALOG_INTENTS.has("PRODUCT_SEARCH")).toBe(false);
    expect(NON_CATALOG_INTENTS.has("PRODUCT_STOCK")).toBe(false);
    expect(NON_CATALOG_INTENTS.has("GENERAL")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Deteksi deterministik — 12 pertanyaan wajib (Bagian 10)           */
/* ------------------------------------------------------------------ */

describe("detectChatbotIntent — 12 pertanyaan wajib (semua peran)", () => {
  const WAJIB: [string, ChatbotIntent][] = [
    ["Berapa total pendapatan?", "REVENUE"],
    ["Berapa pendapatan toko saya?", "REVENUE"],
    ["Berapa jumlah penjual?", "SELLER_INFO"],
    ["Berapa jumlah pembeli?", "BUYER_INFO"],
    ["Berapa jumlah pesanan?", "ORDER_COUNT"],
    ["Produk apa saja yang tersedia?", "PRODUCT_SEARCH"],
    ["Produk hasil laut di bawah Rp50.000?", "PRODUCT_SEARCH"],
    ["Berapa stok ikan kerapu?", "PRODUCT_STOCK"],
    ["Pesanan saya sudah sampai mana?", "ORDER_STATUS"],
    ["Siapa kamu?", "GENERAL"],
    ["Apa aturan penggunaan Mendung Tirta?", "SERVICE_INFO"],
    ["Jelaskan layanan Mendung Tirta.", "SERVICE_INFO"],
  ];

  for (const [pesan, expected] of WAJIB) {
    it(`"${pesan}" → ${expected} (keyakinan tinggi, tanpa jaringan)`, () => {
      const r = detectChatbotIntent(pesan);
      expect(r.intent).toBe(expected);
      expect(r.confidence).toBe("high");
      expect(r.source).toBe("deterministic");
    });
  }
});

describe("detectChatbotIntent — sinonim & variasi bahasa", () => {
  it("sinonim pendapatan → REVENUE", () => {
    expect(detectChatbotIntent("Berapa omzet toko saya?").intent).toBe("REVENUE");
    expect(detectChatbotIntent("Gimana pemasukan kas toko?").intent).toBe("REVENUE");
    expect(detectChatbotIntent("Cuan bulan ini berapa?").intent).toBe("REVENUE");
  });

  it("laporan/rekap penjualan → SALES_REPORT", () => {
    expect(detectChatbotIntent("Rekap penjualan bulan ini").intent).toBe("SALES_REPORT");
    expect(detectChatbotIntent("Laporan penjualan toko dong").intent).toBe("SALES_REPORT");
    expect(detectChatbotIntent("Apa produk terlaris bulan ini?").intent).toBe("SALES_REPORT");
  });

  it("hitungan per entitas → kategori masing-masing", () => {
    expect(detectChatbotIntent("Berapa jumlah pengguna terdaftar?").intent).toBe("USER_COUNT");
    expect(detectChatbotIntent("Ada berapa toko di platform ini?").intent).toBe("STORE_INFO");
    expect(detectChatbotIntent("Total pesanan masuk berapa?").intent).toBe("ORDER_COUNT");
  });

  it("status pesanan vs jumlah pesanan tidak tertukar", () => {
    expect(detectChatbotIntent("Bagaimana status pesanan saya?").intent).toBe("ORDER_STATUS");
    expect(detectChatbotIntent("Pesanan saya sudah dikirim belum?").intent).toBe("ORDER_STATUS");
    expect(detectChatbotIntent("Berapa jumlah pesanan saya?").intent).toBe("ORDER_COUNT");
  });

  it("atribut produk → PRODUCT_PRICE / PRODUCT_STOCK / PRODUCT_CATEGORY", () => {
    expect(detectChatbotIntent("Berapa harganya?").intent).toBe("PRODUCT_PRICE");
    expect(detectChatbotIntent("Berapa stoknya?").intent).toBe("PRODUCT_STOCK");
    expect(detectChatbotIntent("Produk apa yang stoknya habis?").intent).toBe("PRODUCT_STOCK");
    expect(detectChatbotIntent("Kategori apa saja yang ada?").intent).toBe("PRODUCT_CATEGORY");
    expect(detectChatbotIntent("Tampilkan semua produk").intent).toBe("PRODUCT_SEARCH");
    expect(detectChatbotIntent("Ada ikan kerapu?").intent).toBe("PRODUCT_SEARCH");
  });

  it("profil toko/penjual → STORE_INFO, tapi pencarian produk tetap PRODUCT_SEARCH", () => {
    expect(detectChatbotIntent("Siapa penjualnya?").intent).toBe("STORE_INFO");
    expect(detectChatbotIntent("Info toko ini dong").intent).toBe("STORE_INFO");
    expect(detectChatbotIntent("Tampilkan produk dari toko Pancing Jaya").intent).toBe("PRODUCT_SEARCH");
  });

  it("akun sendiri → ACCOUNT_INFO; layanan/aturan → SERVICE_INFO", () => {
    expect(detectChatbotIntent("Siapa saya?").intent).toBe("ACCOUNT_INFO");
    expect(detectChatbotIntent("Apa peran akun saya?").intent).toBe("ACCOUNT_INFO");
    expect(detectChatbotIntent("Bagaimana cara berbelanja di sini?").intent).toBe("SERVICE_INFO");
    expect(detectChatbotIntent("Apa saja ketentuan penggunaan aplikasi?").intent).toBe("SERVICE_INFO");
  });

  it("pertanyaan tanpa aturan yang cocok → GENERAL dengan keyakinan rendah", () => {
    const r = detectChatbotIntent("Resep nasi goreng enak gimana ya");
    expect(r.intent).toBe("GENERAL");
    expect(r.confidence).toBe("low");
  });

  it("sapaan tetap GENERAL keyakinan tinggi (tanpa panggilan Gemini)", () => {
    expect(detectChatbotIntent("Halo")).toMatchObject({ intent: "GENERAL", confidence: "high" });
    expect(detectChatbotIntent("Terima kasih banyak")).toMatchObject({ intent: "GENERAL", confidence: "high" });
  });
});

/* ------------------------------------------------------------------ */
/* 2b. Pemisahan ROLE vs AKUN (Bagian: role pengguna & hak akses)      */
/* ------------------------------------------------------------------ */

describe("detectChatbotIntent — pertanyaan ROLE bukan profil akun", () => {
  // 8 pertanyaan wajib — Q1–Q5 TIDAK BOLEH jatuh ke ACCOUNT_INFO.
  const WAJIB: [string, ChatbotIntent][] = [
    ["Ada apa saja role pengguna?", "USER_ROLES"],
    ["Apa tugas admin?", "ROLE_PERMISSION"],
    ["Apa tugas penjual?", "ROLE_PERMISSION"],
    ["Apa tugas pembeli?", "ROLE_PERMISSION"],
    ["Apa perbedaan ketiganya?", "USER_ROLES"],
    ["Siapa saya?", "ACCOUNT_INFO"],
    ["Apa peran akun saya?", "ACCOUNT_INFO"],
    ["Berapa jumlah pengguna setiap role?", "USER_COUNT"],
  ];

  for (const [pesan, expected] of WAJIB) {
    it(`"${pesan}" → ${expected} (keyakinan tinggi, tanpa jaringan)`, () => {
      const r = detectChatbotIntent(pesan);
      expect(r.intent).toBe(expected);
      expect(r.confidence).toBe("high");
      expect(r.source).toBe("deterministic");
    });
  }

  it("Q1–Q5 tidak pernah terklasifikasi sebagai ACCOUNT_INFO", () => {
    for (const [pesan] of WAJIB.slice(0, 5)) {
      expect(detectChatbotIntent(pesan).intent).not.toBe("ACCOUNT_INFO");
    }
  });

  it("sinonim jenis role → USER_ROLES", () => {
    // "Siapa saja pengguna …" BUKAN pertanyaan definisi — pindah ke
    // USER_LIST (daftar identitas) di bawah; lihat spesifikasi identitas.
    expect(detectChatbotIntent("Apa jenis akun yang tersedia?").intent).toBe("USER_ROLES");
    expect(detectChatbotIntent("Ada berapa jenis pengguna?").intent).toBe("USER_ROLES");
    expect(detectChatbotIntent("Role apa saja yang tersedia?").intent).toBe("USER_ROLES");
    expect(detectChatbotIntent("Apa perbedaan admin dan pembeli?").intent).toBe("USER_ROLES");
    expect(detectChatbotIntent("Macam-macam peran apa saja?").intent).toBe("USER_ROLES");
  });

  it("sinonim hak akses → ROLE_PERMISSION (target role disebut)", () => {
    expect(detectChatbotIntent("Hak akses seller seperti apa?").intent).toBe("ROLE_PERMISSION");
    expect(detectChatbotIntent("Apa yang bisa dilakukan pembeli?").intent).toBe("ROLE_PERMISSION");
    expect(detectChatbotIntent("Fungsi admin apa saja?").intent).toBe("ROLE_PERMISSION");
    expect(detectChatbotIntent("Kewenangan penjual apa saja?").intent).toBe("ROLE_PERMISSION");
  });

  it("daftar pengguna → USER_LIST (bukan role, bukan akun)", () => {
    expect(detectChatbotIntent("Daftar pengguna dong").intent).toBe("USER_LIST");
    expect(detectChatbotIntent("Tampilkan daftar pengguna").intent).toBe("USER_LIST");
    expect(detectChatbotIntent("Sebutkan semua user").intent).toBe("USER_LIST");
  });

  it("pertanyaan milik sendiri tetap ACCOUNT_INFO (role tidak membajak)", () => {
    expect(detectChatbotIntent("Siapa saya?").intent).toBe("ACCOUNT_INFO");
    expect(detectChatbotIntent("Apa peran akun saya?").intent).toBe("ACCOUNT_INFO");
    expect(detectChatbotIntent("Profil saya seperti apa?").intent).toBe("ACCOUNT_INFO");
    expect(detectChatbotIntent("Ganti password saya dong").intent).toBe("ACCOUNT_INFO");
  });

  it("regresi: hitungan & produk tidak tertukar dengan intent role", () => {
    expect(detectChatbotIntent("Berapa jumlah penjual?").intent).toBe("SELLER_INFO");
    expect(detectChatbotIntent("Berapa jumlah pengguna terdaftar?").intent).toBe("USER_COUNT");
    expect(detectChatbotIntent("Kategori apa saja yang ada?").intent).toBe("PRODUCT_CATEGORY");
    expect(detectChatbotIntent("Produk apa saja yang tersedia?").intent).toBe("PRODUCT_SEARCH");
    expect(detectChatbotIntent("Siapa penjualnya?").intent).toBe("STORE_INFO");
    expect(detectChatbotIntent("Apa beda harga produk ini?").intent).toBe("PRODUCT_PRICE");
  });
});

/* ------------------------------------------------------------------ */
/* 2c. Daftar pengguna MENURUT ROLE — "siapa saja seller?" → USER_LIST */
/* ------------------------------------------------------------------ */

describe("detectChatbotIntent — daftar pengguna per role → USER_LIST", () => {
  // Variasi bahasa dari spesifikasi: daftar penjual/toko/buyer harus dikenali
  // sebagai intent yang SAMA (USER_LIST dengan target), bukan daftar produk.
  const DAFTAR: [string, ChatbotIntent][] = [
    ["Siapa saja seller?", "USER_LIST"],
    ["Siapa saja penjual?", "USER_LIST"],
    ["Tampilkan daftar penjual.", "USER_LIST"],
    ["Tampilkan semua nama toko.", "USER_LIST"],
    ["Siapa saja buyer?", "USER_LIST"],
    ["Tampilkan semua toko", "USER_LIST"],
    ["Sebutkan nama pemilik toko.", "USER_LIST"],
    ["Siapa yang berjualan di Mendung Tirta?", "USER_LIST"],
    ["Siapa nama toko yang terdaftar?", "USER_LIST"],
    ["Tampilkan seller yang memiliki produk tersedia.", "USER_LIST"],
  ];

  for (const [pesan] of DAFTAR) {
    it(`"${pesan}" → USER_LIST (keyakinan tinggi, tanpa jaringan)`, () => {
      const r = detectChatbotIntent(pesan);
      expect(r.intent).toBe("USER_LIST");
      expect(r.confidence).toBe("high");
      expect(r.source).toBe("deterministic");
    });
  }

  it("pertanyaan JUMLAH tetap hitungan per entitas (bukan daftar)", () => {
    expect(detectChatbotIntent("Berapa jumlah seller?").intent).toBe("SELLER_INFO");
    expect(detectChatbotIntent("Berapa jumlah pengguna dengan role SELLER?").intent).toBe("SELLER_INFO");
    expect(detectChatbotIntent("Ada berapa penjual?").intent).toBe("SELLER_INFO");
    expect(detectChatbotIntent("Ada berapa admin?").intent).toBe("USER_COUNT");
    expect(detectChatbotIntent("Tampilkan jumlah pengguna setiap role.").intent).toBe("USER_COUNT");
  });

  it("pertanyaan produk/profil toko tidak dibajak daftar pengguna", () => {
    expect(detectChatbotIntent("Tampilkan semua produk").intent).toBe("PRODUCT_SEARCH");
    expect(detectChatbotIntent("Tampilkan produk dari toko Pancing Jaya").intent).toBe("PRODUCT_SEARCH");
    expect(detectChatbotIntent("Apa saja produk yang tersedia?").intent).toBe("PRODUCT_SEARCH");
    expect(detectChatbotIntent("Siapa penjualnya?").intent).toBe("STORE_INFO");
    expect(detectChatbotIntent("Siapa penjual ikan kerapu?").intent).toBe("STORE_INFO");
    expect(detectChatbotIntent("Info toko ini dong").intent).toBe("STORE_INFO");
  });

  it("daftar role & hak akses tetap USER_ROLES / ROLE_PERMISSION", () => {
    expect(detectChatbotIntent("Ada apa saja role pengguna?").intent).toBe("USER_ROLES");
    expect(detectChatbotIntent("Kewenangan penjual apa saja?").intent).toBe("ROLE_PERMISSION");
    expect(detectChatbotIntent("Apa tugas penjual?").intent).toBe("ROLE_PERMISSION");
  });
});

/* ------------------------------------------------------------------ */
/* 2d. Daftar IDENTITAS pengguna — nama dari DB, bukan sekadar angka    */
/* ------------------------------------------------------------------ */

describe("detectChatbotIntent — daftar identitas pengguna → USER_LIST", () => {
  // Spesifikasi identitas: chatbot wajib menyebutkan NAMA pengguna dari
  // database (dikelompokkan per role) — bukan definisi role, bukan angka.
  const DAFTAR: [string, ChatbotIntent][] = [
    ["Siapa saja pengguna Mendung Tirta?", "USER_LIST"],
    ["Siapa saja pengguna?", "USER_LIST"],
    ["Siapa saja penggunanya?", "USER_LIST"],
    ["Siapa saja pengguna yang aktif?", "USER_LIST"],
    ["Siapa saja pengguna yang belum aktif?", "USER_LIST"],
    ["Tampilkan semua pengguna.", "USER_LIST"],
    ["Tampilkan daftar pengguna berdasarkan role.", "USER_LIST"],
    ["Siapa saja admin?", "USER_LIST"],
    ["Siapa saja seller atau penjual?", "USER_LIST"],
    ["Siapa saja buyer atau pembeli?", "USER_LIST"],
    ["Siapa nama seluruh penjual?", "USER_LIST"],
    ["Sebutkan nama penjual beserta nama tokonya.", "USER_LIST"],
    ["Tampilkan daftar pengguna", "USER_LIST"],
    ["Daftar pengguna dong", "USER_LIST"],
  ];

  for (const [pesan, expected] of DAFTAR) {
    it(`"${pesan}" → ${expected} (keyakinan tinggi, tanpa jaringan)`, () => {
      const r = detectChatbotIntent(pesan);
      expect(r.intent).toBe(expected);
      expect(r.confidence).toBe("high");
      expect(r.source).toBe("deterministic");
    });
  }

  it("pertanyaan jumlah + nama → USER_COUNT (daftar menyusul via konteks)", () => {
    expect(detectChatbotIntent("Ada berapa pengguna dan siapa namanya?").intent).toBe(
      "USER_COUNT",
    );
    // Tanpa penanda daftar → tetap hitungan murni.
    expect(detectChatbotIntent("Berapa jumlah pengguna terdaftar?").intent).toBe("USER_COUNT");
  });

  it("pemilik toko SATU orang tetap STORE_INFO (bukan daftar pengguna)", () => {
    expect(detectChatbotIntent("Siapa pemilik toko Pancing Jaya Abadi?").intent).toBe(
      "STORE_INFO",
    );
  });
});

describe("detectUserListTarget — target daftar dari pesan (murni)", () => {
  it("menangkap entitas target setelah penanda permintaan daftar", () => {
    expect(detectUserListTarget("Siapa saja seller?")).toBe("SELLER");
    expect(detectUserListTarget("Tampilkan daftar penjual")).toBe("SELLER");
    expect(detectUserListTarget("Sebutkan nama pemilik toko.")).toBe("SELLER");
    expect(detectUserListTarget("Siapa yang berjualan di Mendung Tirta?")).toBe("SELLER");
    expect(detectUserListTarget("Tampilkan semua nama toko.")).toBe("STORE");
    expect(detectUserListTarget("Siapa saja buyer?")).toBe("BUYER");
    expect(detectUserListTarget("Daftar pembeli dong")).toBe("BUYER");
    expect(detectUserListTarget("Tampilkan admin terdaftar")).toBe("ADMIN");
    expect(detectUserListTarget("Daftar pengguna dong")).toBe("ALL");
    // Sufiks -nya & filter status tidak mengaburkan target.
    expect(detectUserListTarget("Siapa saja penggunanya?")).toBe("ALL");
    expect(detectUserListTarget("Siapa saja pengguna yang aktif?")).toBe("ALL");
    expect(detectUserListTarget("Siapa saja pengguna yang belum aktif?")).toBe("ALL");
    expect(detectUserListTarget("Siapa saja admin?")).toBe("ADMIN");
    expect(detectUserListTarget("Tampilkan semua pengguna.")).toBe("ALL");
  });

  it("bukan permintaan daftar → null (jumlah, milik sendiri, produk, profil toko)", () => {
    expect(detectUserListTarget("Berapa jumlah seller?")).toBeNull();
    expect(detectUserListTarget("Tampilkan jumlah pengguna setiap role.")).toBeNull();
    expect(detectUserListTarget("Tampilkan toko saya")).toBeNull();
    expect(detectUserListTarget("Tampilkan semua produk")).toBeNull();
    expect(detectUserListTarget("Tampilkan produk dari toko Pancing Jaya")).toBeNull();
    expect(detectUserListTarget("Siapa penjualnya?")).toBeNull();
    expect(detectUserListTarget("Siapa penjual ikan kerapu?")).toBeNull();
    expect(detectUserListTarget("Halo")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Klasifikasi akhir — deteksi dulu, Gemini menyempurnakan          */
/* ------------------------------------------------------------------ */

describe("classifyChatbotIntent — penyempurnaan Gemini (tahan-gagal)", () => {
  const KEY = "AIza-TESTKEY-000000000000000000000000000000000";
  let prevGem: string | undefined;
  let prevAlias: string | undefined;

  beforeEach(() => {
    prevGem = process.env.GEMINI_API_KEY;
    prevAlias = process.env.AI_API_KEY;
  });

  afterEach(() => {
    if (prevGem === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGem;
    if (prevAlias === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = prevAlias;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const geminiJson = (text: string, ok = true) =>
    new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
      { status: ok ? 200 : 500 },
    );

  it("keyakinan tinggi → TANPA panggilan provider", async () => {
    process.env.GEMINI_API_KEY = KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await classifyChatbotIntent("Berapa total pendapatan?");
    expect(r).toMatchObject({ intent: "REVENUE", source: "deterministic" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GENERAL + sinyal data + sinonim tak dikenal → klasifikasi ulang via Gemini", async () => {
    process.env.GEMINI_API_KEY = KEY;
    const fetchSpy = vi.fn(async () => geminiJson('{"intent":"REVENUE"}'));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await classifyChatbotIntent("berapa duit masuk minggu ini", ["halo"]);
      expect(r.intent).toBe("REVENUE");
      expect(r.source).toBe("gemini");
      expect(r.confidence).toBe("high");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Key tidak pernah terkirim sebagai konten pesan, hanya header backend.
      const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(JSON.stringify(init.body))).not.toContain(KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("balasan Gemini bukan JSON valid → kembali ke deteksi deterministik", async () => {
    process.env.GEMINI_API_KEY = KEY;
    vi.stubGlobal("fetch", vi.fn(async () => geminiJson("maaf, bukan json")));
    try {
      const r = await classifyChatbotIntent("berapa duit masuk minggu ini");
      expect(r.intent).toBe("GENERAL");
      expect(r.source).toBe("deterministic");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("provider error/jaringan gagal → TIDAK melempar, tetap deterministik", async () => {
    process.env.GEMINI_API_KEY = KEY;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("jaringan putus"); }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await classifyChatbotIntent("berapa duit masuk minggu ini");
      expect(r.intent).toBe("GENERAL");
      expect(r.source).toBe("deterministic");
      // Log aman: tanpa isi key.
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).not.toContain(KEY);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("tanpa API key → deteksi deterministik, provider tidak dipanggil", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await classifyChatbotIntent("berapa duit masuk minggu ini");
    expect(r).toMatchObject({ intent: "GENERAL", source: "deterministic" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tanpa sinyal data → tidak membuang panggilan Gemini", async () => {
    process.env.GEMINI_API_KEY = KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await classifyChatbotIntent("makanan penutup apa yang enak");
    expect(r.intent).toBe("GENERAL");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* 4. Parameter terstruktur — paduan deterministik + Gemini            */
/* ------------------------------------------------------------------ */

describe("mergeIntentParams — parameter pencarian terstruktur", () => {
  const empty: ProductFilter = {};

  it("params undefined → filter dikembalikan apa adanya", () => {
    expect(mergeIntentParams(empty, undefined)).toBe(empty);
  });

  it("mengisi harga/kategori/stok/sorting yang belum ditentukan deteksi lokal", () => {
    const merged = mergeIntentParams(empty, {
      priceMax: 50000,
      priceMaxExclusive: true,
      category: "Hasil Laut",
      inStock: true,
      sortBy: "price_asc",
    });
    expect(merged.price).toEqual({ min: undefined, max: 50000, maxExclusive: true });
    expect(merged.category).toBe("Hasil Laut");
    expect(merged.inStock).toBe(true);
    expect(merged.sortBy).toBe("price_asc");
  });

  it("deteksi lokal tetap menang bila sudah menemukan sendiri", () => {
    const local: ProductFilter = { price: { min: 1000, max: 2000, maxExclusive: false }, category: "Umpan" };
    const merged = mergeIntentParams(local, { priceMax: 999999, category: "Alat Pancing" });
    expect(merged.price).toEqual(local.price);
    expect(merged.category).toBe("Umpan");
  });

  it("hanya priceMin (tanpa max) → tetap valid", () => {
    const merged = mergeIntentParams({}, { priceMin: 20000 });
    expect(merged.price).toEqual({ min: 20000, max: undefined, maxExclusive: false });
  });
});

/* ------------------------------------------------------------------ */
/* 5. Kompatibilitas — deteksi lama tetap berfungsi lewat modul ini     */
/* ------------------------------------------------------------------ */

describe("kompatibilitas deteksi lama (re-export ai-context)", () => {
  it("detectIntents & detectCountQuery tetap mengenali pola lama", () => {
    expect(detectIntents("pendapatan toko")).toContain("sales");
    expect(detectIntents("status pesanan saya")).toContain("order");
    expect(detectIntents("Apa aturan penggunaan Mendung Tirta?")).toContain("appinfo");
    expect(detectCountQuery("Berapa jumlah penjual?")).toEqual(["seller"]);
    expect(detectCountQuery("Berapa penjualan bulan ini?")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Domain data baru — pemilik toko, peringkat, pembeli produk,      */
/*    ekstrem harga, statistik eksplisit, hitungan Payment/Review      */
/* ------------------------------------------------------------------ */

describe("deteksi intent domain data baru", () => {
  it("\"Siapa pemilik toko …\" → STORE_INFO (high, deterministik)", () => {
    for (const q of [
      "Siapa pemilik toko Pancing Jaya Abadi?",
      "Siapa pemiliknya toko Hasil Laut?",
      "Pemilik toko ini siapa?",
    ]) {
      expect(detectChatbotIntent(q)).toMatchObject({
        intent: "STORE_INFO",
        confidence: "high",
        source: "deterministic",
      });
    }
    // Bukan daftar pengguna — "pemilik toko <nama>" menanyakan SATU orang.
    expect(detectChatbotIntent("Siapa pemilik toko Pancing Jaya Abadi?").intent).not.toBe(
      "USER_LIST",
    );
  });

  it("peringkat toko (produk terbanyak) → STORE_INFO, bukan pencarian produk", () => {
    for (const q of [
      "Toko mana yang memiliki produk terbanyak?",
      "Toko mana yang paling banyak produknya?",
      "Store mana yang produknya paling banyak?",
    ]) {
      expect(detectChatbotIntent(q)).toMatchObject({
        intent: "STORE_INFO",
        confidence: "high",
      });
      expect(STORE_RANK_RE.test(q.toLowerCase())).toBe(true);
    }
    // Pertanyaan produk biasa TIDAK ikut terbajak jadi peringkat toko.
    expect(STORE_RANK_RE.test("produk mana yang paling banyak dibeli")).toBe(false);
  });

  it("pembeli dari suatu produk → ORDER_STATUS (fetcher khusus, bukan katalog)", () => {
    for (const q of [
      "Siapa pembeli yang memesan ikan kerapu?",
      "Siapa yang membeli umpan minnow?",
      "Siapa pembeli produk joran tegek?",
    ]) {
      expect(detectBuyersOfProduct(q)).toBe(true);
      expect(detectChatbotIntent(q)).toMatchObject({
        intent: "ORDER_STATUS",
        confidence: "high",
      });
    }
    expect(detectBuyersOfProduct("Berapa jumlah pembeli?")).toBe(false);
    // Daftar pembeli "siapa saja" tetap USER_LIST (gerbang lama dipertahankan).
    expect(detectChatbotIntent("Siapa saja pembeli?").intent).toBe("USER_LIST");
  });

  it("ekstrem harga — hanya bila KEDUA sisi disebut (regresi 'Produk termurah.')", () => {
    expect(detectProductExtremes("Produk apa yang paling mahal dan paling murah?")).toBe(true);
    expect(detectProductExtremes("Produk termahal dan termurah apa?")).toBe(true);
    expect(detectProductExtremes("Harga tertinggi dan terendah berapa?")).toBe(true);
    // Jalur lama TIDAK berubah: satu sisi = urutan/filter biasa.
    expect(detectProductExtremes("Produk termurah.")).toBe(false);
    expect(detectProductExtremes("Produk paling mahal dong")).toBe(false);
    expect(detectProductExtremes("Berapa jumlah penjual?")).toBe(false);
    expect(detectProductExtremes("stok paling tinggi dan paling rendah")).toBe(false);
  });

  it("kata 'statistik' eksplisit → MARKETPLACE_STATS menang atas 'pendapatan' di dalamnya", () => {
    expect(
      detectChatbotIntent("Tampilkan statistik produk, toko, pesanan, pendapatan, dan ulasan."),
    ).toMatchObject({ intent: "MARKETPLACE_STATS", confidence: "high" });
    expect(detectChatbotIntent("Berikan ringkasan seluruh marketplace.")).toMatchObject({
      intent: "MARKETPLACE_STATS",
      confidence: "high",
    });
    // Laporan penjualan EKSPLISIT tetap menang (kata "laporan/rekap/penjualan").
    expect(detectChatbotIntent("Rekap penjualan bulan ini")).toMatchObject({
      intent: "SALES_REPORT",
    });
    expect(detectChatbotIntent("Berapa total pendapatan?")).toMatchObject({
      intent: "REVENUE",
    });
  });

  it("'performa toko saya bulan ini' → SALES_REPORT (bukan GENERAL/ke Gemini)", () => {
    expect(detectChatbotIntent("gimana performa toko saya bulan ini")).toMatchObject({
      intent: "SALES_REPORT",
      confidence: "high",
    });
  });

  it("filter toko menolak kata tanya (bukan nama toko)", () => {
    expect(parseStoreFilter("Toko mana yang memiliki produk terbanyak?")).toBeNull();
    expect(parseStoreFilter("Toko mana yang paling banyak produknya?")).toBeNull();
    // Nama toko asli tetap dikenali.
    expect(parseStoreFilter("Tampilkan produk dari toko Pancing Jaya Abadi.")).toBe(
      "pancing jaya abadi",
    );
  });
});

describe("detectCountQuery — hitungan Payment & Review", () => {
  it("transaksi/pembayaran BERHASIL → paidPayments (tabel Payment PAID)", () => {
    expect(detectCountQuery("Berapa transaksi berhasil?")).toEqual(["paidPayments"]);
    expect(detectCountQuery("Berapa pembayaran yang berhasil?")).toEqual(["paidPayments"]);
    expect(detectCountQuery("Ada berapa pembayaran sukses?")).toEqual(["paidPayments"]);
  });

  it("negasi TIDAK dihitung berhasil — tetap hitungan pesanan biasa", () => {
    expect(detectCountQuery("Berapa pesanan yang menunggu pembayaran?")).toEqual(["orders"]);
    expect(detectCountQuery("Berapa transaksi yang gagal?")).toEqual(["orders"]);
    expect(detectCountQuery("Berapa jumlah seluruh pesanan?")).toEqual(["orders"]);
    expect(detectCountQuery("Berapa transaksi belum berhasil?")).toEqual(["orders"]);
  });

  it("jumlah ulasan → reviews; rating rata-rata → avgRating", () => {
    expect(detectCountQuery("Berapa jumlah ulasan?")).toEqual(["reviews"]);
    expect(detectCountQuery("Ada berapa review produk?")).toEqual(["reviews"]);
    expect(detectCountQuery("Berapa rating rata-rata produk?")).toEqual(["avgRating"]);
    expect(detectCountQuery("Berapa rerata rating produk ini?")).toEqual(["avgRating"]);
  });

  it("superlatif rating BUKAN pertanyaan rata-rata (→ daftar/urutan produk)", () => {
    expect(detectCountQuery("Berapa rating produk tertinggi?")).toEqual([]);
    expect(detectCountQuery("Tampilkan rating tertinggi")).toEqual([]);
    // Permintaan daftar tetap BUKAN hitungan.
    expect(detectCountQuery("Tampilkan daftar ulasan terbaru")).toEqual([]);
  });

  it("intent utama: paidPayments → ORDER_COUNT; reviews/avgRating → jalur produk", () => {
    expect(detectChatbotIntent("Berapa transaksi berhasil?")).toMatchObject({
      intent: "ORDER_COUNT",
    });
    expect(detectChatbotIntent("Berapa jumlah ulasan?")).toMatchObject({
      intent: "PRODUCT_SEARCH",
    });
    expect(detectChatbotIntent("Berapa rating rata-rata produk?")).toMatchObject({
      intent: "PRODUCT_SEARCH",
    });
  });
});

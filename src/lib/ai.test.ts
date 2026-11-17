import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractKeywords,
  extractSubjectPhrase,
  canonicalSubject,
  matchSubjectToCategories,
  describePriceFilterText,
  isSingleProductQuestion,
  fallbackResult,
  generateReply,
  streamReply,
  isGreetingMessage,
  parsePriceFilter,
  parseProductFilters,
  parseCategoryFilter,
  parseStoreFilter,
  parseSortOrder,
  parseStockFilter,
  parseMinRating,
  filterProductsByPrice,
  productMatchesPriceFilter,
  type AiProduct,
  type AiChatResult,
  type PriceFilter,
  type ProductFilter,
} from "@/lib/ai";
import type { ContextSection } from "@/lib/ai-context";

describe("extractKeywords (AI grounding)", () => {
  it("mengambil kata bermakna dan membuang kata umum", () => {
    const kw = extractKeywords("tolong carikan joran yang bagus untuk pemula");
    expect(kw).toContain("joran");
    expect(kw).toContain("bagus");
    expect(kw).toContain("pemula");
    expect(kw).not.toContain("yang");
    expect(kw).not.toContain("tolong");
  });

  it("membuang tanda baca, menurunkan huruf kecil, dan menghindari duplikat", () => {
    const kw = extractKeywords("Joran, JORAN! umpan?");
    expect(kw).toEqual(["joran", "umpan"]);
  });

  it("membatasi maksimal 6 kata kunci", () => {
    const kw = extractKeywords("satu dua tiga empat lima enam tujuh delapan sembilan");
    expect(kw.length).toBeLessThanOrEqual(6);
  });

  it("pesan tanpa kata bermakna menghasilkan array kosong", () => {
    expect(extractKeywords("hai kak")).toEqual([]);
    expect(extractKeywords("  ")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Price Filter Parser & Validation (Deterministik, tanpa AI)        */
/* ------------------------------------------------------------------ */

describe("parsePriceFilter — bahasa alami Indonesia ke filter terstruktur", () => {
  it("'di bawah 50000' → max=50000, eksklusif", () => {
    const f = parsePriceFilter("produk di bawah 50000");
    expect(f).toEqual({ max: 50000, maxExclusive: true });
  });

  it("'kurang dari 50000' → max=50000, eksklusif", () => {
    const f = parsePriceFilter("produk kurang dari 50000");
    expect(f).toEqual({ max: 50000, maxExclusive: true });
  });

  it("'di bawah Rp50.000' → max=50000, eksklusif", () => {
    const f = parsePriceFilter("produk di bawah Rp50.000");
    expect(f).toEqual({ max: 50000, maxExclusive: true });
  });

  it("'maksimal 50000' → max=50000, inklusif", () => {
    const f = parsePriceFilter("produk maksimal 50000");
    expect(f).toEqual({ max: 50000, maxExclusive: false });
  });

  it("'maksimal Rp50.000' → max=50000, inklusif", () => {
    const f = parsePriceFilter("produk maksimal Rp50.000");
    expect(f).toEqual({ max: 50000, maxExclusive: false });
  });

  it("'di atas 100000' → min=100000", () => {
    const f = parsePriceFilter("produk di atas 100000");
    expect(f).toEqual({ min: 100000 });
  });

  it("'lebih dari 100000' → min=100000", () => {
    const f = parsePriceFilter("produk lebih dari 100000");
    expect(f).toEqual({ min: 100000 });
  });

  it("'20 ribu sampai 50 ribu' → min=20000, max=50000", () => {
    const f = parsePriceFilter("produk 20 ribu sampai 50 ribu");
    expect(f).toEqual({ min: 20000, max: 50000, maxExclusive: false });
  });

  it("'20000-50000' → min=20000, max=50000", () => {
    const f = parsePriceFilter("produk 20000-50000");
    expect(f).toEqual({ min: 20000, max: 50000, maxExclusive: false });
  });

  it("'50 ribu' → 50000", () => {
    const f = parsePriceFilter("produk 50 ribu");
    expect(f?.max).toBe(50000);
  });

  it("'lima puluh ribu' tidak diparse (hanya angka digit)", () => {
    const f = parsePriceFilter("produk lima puluh ribu");
    // Parser hanya mengenali angka digit, bukan kata
    expect(f).toBeNull();
  });

  it("tanpa filter harga → null", () => {
    expect(parsePriceFilter("apa saja produk yang tersedia")).toBeNull();
    expect(parsePriceFilter("halo")).toBeNull();
  });

  it("format Rp dengan spasi: 'Rp 50.000'", () => {
    const f = parsePriceFilter("maksimal Rp 50.000");
    expect(f).toEqual({ max: 50000, maxExclusive: false });
  });

  it("'Rp50.000' tanpa spasi", () => {
    const f = parsePriceFilter("di bawah Rp50.000");
    expect(f).toEqual({ max: 50000, maxExclusive: true });
  });
});

describe("productMatchesPriceFilter — validasi deterministik produk vs filter", () => {
  const p35k: AiProduct = { ...minnow }; // 35000
  const p50k: AiProduct = { ...minnow, id: "p50k", price: 50000 };
  const p85k: AiProduct = { ...kerapu }; // 85000

  it("harga 35000 lolos filter 'di bawah 50000'", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: true };
    expect(productMatchesPriceFilter(p35k, f)).toBe(true);
  });

  it("harga 49999 lolos filter 'di bawah 50000'", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: true };
    expect(productMatchesPriceFilter({ ...p35k, price: 49999 }, f)).toBe(true);
  });

  it("harga 50000 TIDAK lolos filter 'di bawah 50000' (eksklusif)", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: true };
    expect(productMatchesPriceFilter(p50k, f)).toBe(false);
  });

  it("harga 50000 LOLOS filter 'maksimal 50000' (inklusif)", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: false };
    expect(productMatchesPriceFilter(p50k, f)).toBe(true);
  });

  it("harga 85000 TIDAK lolos filter 'di bawah 50000'", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: true };
    expect(productMatchesPriceFilter(p85k, f)).toBe(false);
  });

  it("harga 35000 lolos filter '20000-50000'", () => {
    const f: PriceFilter = { min: 20000, max: 50000, maxExclusive: false };
    expect(productMatchesPriceFilter(p35k, f)).toBe(true);
  });

  it("harga 15000 TIDAK lolos filter min=20000", () => {
    const f: PriceFilter = { min: 20000 };
    expect(productMatchesPriceFilter({ ...p35k, price: 15000 }, f)).toBe(false);
  });

  it("filter null → semua produk lolos", () => {
    expect(productMatchesPriceFilter(p85k, null)).toBe(true);
  });
});

describe("filterProductsByPrice — filter array produk", () => {
  const products = [minnow, cumi, kerapu]; // 35k, 45k (OOS), 85k

  it("filter 'di bawah 50000' → hanya minnow (35k) dan cumi (45k)", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: true };
    const result = filterProductsByPrice(products, f);
    expect(result.map((p) => p.price)).toEqual([35000, 45000]);
  });

  it("filter 'maksimal 50000' → minnow, cumi, dan produk 50k", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: false };
    const with50k = [...products, { ...minnow, id: "p50k", price: 50000 }];
    const result = filterProductsByPrice(with50k, f);
    expect(result.map((p) => p.price).sort()).toEqual([35000, 45000, 50000]);
  });

  it("filter 'di bawah 50000' → produk 85k TIDAK muncul", () => {
    const f: PriceFilter = { max: 50000, maxExclusive: true };
    const result = filterProductsByPrice(products, f);
    expect(result.find((p) => p.price === 85000)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Fallback berbasis data — pertanyaan SATU produk vs ringkasan katalog */
/* ------------------------------------------------------------------ */

const GEN_AT = "2026-10-21T00:00:00.000Z";

// Data berbentuk seperti hasil query DB aktual (bukan angka karangan test).
const kerapu: AiProduct = {
  id: "8eaead22-29bc-49eb-903e-db25bed393f9",
  name: "Ikan Kerapu Macan Segar (1 Kg)",
  price: 85000,
  stock: 4,
  image: null,
  storeName: "Hasil Laut Pak Budi",
  categoryName: "Hasil Laut",
  rating: 0,
  ratingCount: 0,
  status: "AVAILABLE",
};

const cumi: AiProduct = {
  id: "d3f1a7a0-1111-4222-8333-444455556666",
  name: "Cumi-cumi Ring Segar (500 gr)",
  price: 45000,
  stock: 10,
  image: null,
  storeName: "Hasil Laut Pak Budi",
  categoryName: "Hasil Laut",
  rating: 0,
  ratingCount: 0,
  status: "OUT_OF_STOCK",
};

const minnow: AiProduct = {
  id: "8f7b8663-e5ff-46b4-b399-454106960ed9",
  name: "Umpan Minnow Lure 10cm",
  price: 35000,
  stock: 49,
  image: null,
  storeName: "Pancing Jaya Abadi",
  categoryName: "Umpan",
  rating: 0,
  ratingCount: 0,
  status: "AVAILABLE",
};

const catalogSection: ContextSection = {
  key: "catalog",
  label: "Ringkasan katalog (hitungan produk per ketersediaan)",
  scope: "publik",
  asOf: GEN_AT,
  text: "Total produk non-hidden: 4\nTersedia untuk dibeli: 3\nStok habis / tidak tersedia: 1",
};

// Section hitungan — persis bentuk hasil fetchCountSection (data aktual DB).
const countSection: ContextSection = {
  key: "count",
  label: "Jumlah penjual (data aktual)",
  scope: "publik",
  asOf: GEN_AT,
  text: "Saat ini terdapat 3 penjual terdaftar di Mendung Tirta.",
};

describe("fallbackResult — fokus produk vs ringkasan katalog", () => {
  it("pertanyaan stok 1 produk → jawaban spesifik, BUKAN ringkasan katalog", () => {
    const r = fallbackResult({
      message: "Berapa stok ikan kerapu?",
      products: [kerapu],
      sections: [catalogSection],
      focus: kerapu,
      generatedAt: GEN_AT,
    });
    expect(r.reply).toContain("Ikan Kerapu Macan Segar (1 Kg)");
    expect(r.reply).toContain("Stok: 4");
    expect(r.reply).toContain("Rp85.000");
    expect(r.reply).toContain("Hasil Laut Pak Budi");
    // Tidak menampilkan ringkasan seluruh katalog / daftar produk lain.
    expect(r.reply).not.toContain("Ringkasan katalog");
    expect(r.reply).not.toContain("Total produk");
    expect(r.reply).not.toContain("mode katalog");
    expect(r.products).toHaveLength(1);
    expect(r.products[0].id).toBe(kerapu.id);
    expect(r.sources.some((s) => s.label === "Katalog produk Mendung Tirta")).toBe(true);
  });

  it("produk ditemukan tapi status OUT_OF_STOCK → menyatakan stok habis", () => {
    const r = fallbackResult({
      message: "stok cumi-cumi berapa?",
      products: [],
      sections: [],
      focus: cumi,
      generatedAt: GEN_AT,
    });
    expect(r.reply).toContain("Cumi-cumi Ring Segar");
    expect(r.reply).toMatch(/ditemukan, tetapi stoknya habis/);
    expect(r.reply).toContain("Habis / tidak tersedia");
  });

  it("pertanyaan varian/ukuran + fokus → catatan data ukuran tidak tersedia", () => {
    const r = fallbackResult({
      message: "Ada ukuran lain?",
      products: [minnow],
      sections: [],
      focus: minnow,
      generatedAt: GEN_AT,
    });
    expect(r.reply).toContain("Umpan Minnow Lure 10cm");
    expect(r.reply).toContain("detail ukuran/varian belum tersedia");
  });

  it("beberapa nama cocok → minta klarifikasi dan daftarkan kandidat", () => {
    const r = fallbackResult({
      message: "cari ikan segar",
      products: [],
      sections: [],
      focusCandidates: [kerapu, cumi],
      generatedAt: GEN_AT,
    });
    expect(r.reply).toMatch(/beberapa produk yang cocok/);
    expect(r.reply).toContain("Ikan Kerapu Macan Segar (1 Kg)");
    expect(r.reply).toContain("Cumi-cumi Ring Segar (500 gr)");
    expect(r.reply).toMatch(/Produk mana yang Anda maksud/);
  });

  it("pertanyaan lanjutan ambigu → minta klarifikasi tanpa dump katalog", () => {
    const r = fallbackResult({
      message: "Berapa harganya?",
      products: [minnow, kerapu],
      sections: [],
      ambiguousFollowUp: true,
      generatedAt: GEN_AT,
    });
    expect(r.reply).toMatch(/produk yang mana/);
    expect(r.products).toEqual([]);
    expect(r.sources).toEqual([]);
    expect(r.reply).not.toContain("Umpan Minnow");
  });

  it("pertanyaan produk habis → daftar habis + hitungan saja, tanpa banjir katalog", () => {
    const outSection: ContextSection = {
      key: "outofstock",
      label: "Produk dengan stok habis (katalog publik)",
      scope: "publik",
      asOf: GEN_AT,
      text: "Cumi-cumi Ring Segar (500 gr) — stok 10 (status OUT_OF_STOCK) — Rp45.000 — Hasil Laut Pak Budi",
    };
    const r = fallbackResult({
      message: "Produk apa yang habis?",
      products: [minnow, kerapu],
      sections: [outSection, catalogSection],
      generatedAt: GEN_AT,
    });
    expect(r.reply).toContain("Cumi-cumi Ring Segar (500 gr)");
    expect(r.reply).toContain("Stok habis / tidak tersedia: 1");
    // Tidak membanjiri dengan daftar produk tersedia.
    expect(r.reply).not.toContain("Produk dari katalog:");
    expect(r.reply).not.toContain("Umpan Minnow Lure 10cm");
    expect(r.products).toEqual([]);
    expect(r.sources.some((s) => s.label.includes("stok habis"))).toBe(true);
  });

  it("section akun (non-katalog) → hanya jawaban akun, tanpa label sumber katalog", () => {
    const accountSection: ContextSection = {
      key: "account",
      label: "Informasi akun Anda",
      scope: "milik-sendiri",
      asOf: GEN_AT,
      text: "Nama: Andi Kurniawan\nPeran: Pembeli",
    };
    const r = fallbackResult({
      message: "Siapa saya?",
      products: [],
      sections: [accountSection],
      generatedAt: GEN_AT,
    });
    expect(r.reply).toContain("Andi Kurniawan");
    expect(r.sources.map((s) => s.label)).toEqual(["Informasi akun Anda"]);
  });

  it("pertanyaan 'berapa jumlah penjual?' → HANYA jumlah penjual, tanpa statistik lain", () => {
    const r = fallbackResult({
      message: "Berapa jumlah penjual?",
      products: [],
      sections: [countSection],
      generatedAt: GEN_AT,
    });
    expect(r.reply).toBe("Saat ini terdapat 3 penjual terdaftar di Mendung Tirta.");
    // Tidak membanjiri dengan statistik lain / daftar produk / label katalog.
    expect(r.reply).not.toMatch(/pembeli|pengguna|Pendapatan|Pesanan per status|Ringkasan katalog/);
    expect(r.products).toEqual([]);
    expect(r.sources.map((s) => s.label)).toEqual(["Jumlah penjual (data aktual)"]);
    expect(r.sources.some((s) => s.label.includes("Katalog"))).toBe(false);
  });

  it("beberapa hitungan dalam satu pertanyaan → semua jawaban hitungan, tanpa daftar produk", () => {
    const buyerCount: ContextSection = {
      key: "count",
      label: "Jumlah pembeli (data aktual)",
      scope: "publik",
      asOf: GEN_AT,
      text: "Saat ini terdapat 26 pembeli terdaftar di Mendung Tirta.",
    };
    const r = fallbackResult({
      message: "Berapa jumlah penjual dan pembeli?",
      products: [minnow],
      sections: [countSection, buyerCount],
      generatedAt: GEN_AT,
    });
    expect(r.reply).toContain("3 penjual terdaftar");
    expect(r.reply).toContain("26 pembeli terdaftar");
    expect(r.products).toEqual([]);
    expect(r.reply).not.toContain("Umpan Minnow");
  });
});

/* ------------------------------------------------------------------ */
/* generateReply — kondisi provider (tanpa jaringan nyata)             */
/* ------------------------------------------------------------------ */

describe("generateReply — kondisi provider AI", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("tanpa GEMINI_API_KEY → fallback + tidak pernah menampilkan key", async () => {
    const prevGem = process.env.GEMINI_API_KEY;
    const prevKey = process.env.AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const r = await generateReply({
        message: "Produk apa saja yang dijual di Mendung Tirta?",
        history: [],
        products: [],
        sections: [catalogSection],
      });
      expect(r.source).toBe("fallback");
      expect(r.fallbackReason).toBe("no-ai-config");
      expect(r.reply).toContain("Berikut data terkini dari aplikasi");
      const logged = info.mock.calls.flat().join(" ");
      expect(logged).not.toMatch(/AIza|nvapi-|Bearer|sk-/i);
    } finally {
      if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
      if (prevKey !== undefined) process.env.AI_API_KEY = prevKey;
    }
  });

  it("pertanyaan berdata (fokus produk) → JALUR DIRECT tanpa AI & tanpa key", async () => {
    // Routing cerdas: fokus/riwayat/hitungan dijawab dari data — provider
    // tidak perlu dipanggil (ini penyebab lambat lama: menunggu AI 90 dtk).
    const prevKey = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk jalur direct");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await generateReply({
        message: "Berapa stok ikan kerapu?",
        history: [],
        products: [kerapu],
        sections: [],
        focus: kerapu,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.source).toBe("fallback");
      expect(r.fallbackReason).toBe("direct");
      expect(r.reply).toContain("Ikan Kerapu Macan Segar (1 Kg)");
    } finally {
      vi.unstubAllGlobals();
      if (prevKey !== undefined) process.env.AI_API_KEY = prevKey;
    }
  });

  it("provider tidak tersedia (DNS gagal) → fallback + error dicatat aman", async () => {
    const prev = {
      key: process.env.AI_API_KEY,
      base: process.env.AI_BASE_URL,
      model: process.env.AI_MODEL,
      timeout: process.env.AI_TIMEOUT_MS,
    };
    process.env.AI_API_KEY = "test-key-rahasia-jangan-log";
    process.env.AI_BASE_URL = "http://ai.invalid/v1"; // TLD .invalid tidak pernah resolve
    process.env.AI_MODEL = "test-model";
    process.env.AI_TIMEOUT_MS = "5000";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await generateReply({
        message: "Apa saja produk yang dijual di sini?",
        history: [],
        products: [],
        sections: [catalogSection],
      });
      expect(r.source).toBe("fallback");
      expect(r.fallbackReason).toBe("provider-error");
      expect(r.reply).toContain("Berikut data terkini dari aplikasi");
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("[ai]");
      expect(logged).not.toContain("test-key-rahasia-jangan-log");
    } finally {
      // Restore bersih: `process.env.X = undefined` akan tersimpan sebagai
      // string "undefined" dan meracuni test berikutnya — hapus saja bila kosong.
      if (prev.key !== undefined) process.env.AI_API_KEY = prev.key;
      else delete process.env.AI_API_KEY;
      if (prev.base !== undefined) process.env.AI_BASE_URL = prev.base;
      else delete process.env.AI_BASE_URL;
      if (prev.model !== undefined) process.env.AI_MODEL = prev.model;
      else delete process.env.AI_MODEL;
      if (prev.timeout !== undefined) process.env.AI_TIMEOUT_MS = prev.timeout;
      else delete process.env.AI_TIMEOUT_MS;
    }
  });

  it("filter harga aktif → fallback deterministik + fallbackReason 'filtered'", async () => {
    // Jalur filter SELALU deterministik (by design) — bukan kegagalan provider,
    // sehingga UI menampilkan catatan "query terfilter", bukan error AI.
    const r = await generateReply({
      message: "Produk di bawah Rp50.000",
      history: [],
      products: [kerapu],
      sections: [],
      filters: { price: { max: 50000, maxExclusive: true } },
    });
    expect(r.source).toBe("fallback");
    expect(r.fallbackReason).toBe("filtered");
    expect(r.reply.length).toBeGreaterThan(0);
  });

  it("provider membalas 401 (API key tidak valid) → fallback, key tidak masuk log", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "AIza-test-tidak-valid";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await generateReply({
        message: "Mengapa ikan laut kaya omega-3?",
        history: [],
        products: [],
        sections: [],
      });
      expect(r.source).toBe("fallback");
      expect(r.fallbackReason).toBe("provider-error");
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("provider HTTP 401");
      expect(logged).not.toContain("AIza-test-tidak-valid");
    } finally {
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("respons AI valid (API native Gemini) → sumber 'ai', marker [produk:id] divalidasi ke grounding", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: `Stok Ikan Kerapu saat ini 4. [produk:${kerapu.id}] [produk:00000000-0000-0000-0000-000000000000]`,
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const prev = { key: process.env.GEMINI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.GEMINI_API_KEY = "AIza-test-key";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    try {
      const r = await generateReply({
        message: "Ceritakan soal stok ikan kerapu untuk pembeli",
        history: [],
        products: [kerapu],
        sections: [],
        // Tanpa focus/contextProducts → pertanyaan terbuka = jalur AI dengan
        // KATALOG sebagai grounding (marker [produk:id] tetap divalidasi).
      });
      expect(r.source).toBe("ai");
      expect(r.reply).toContain("Stok Ikan Kerapu saat ini 4");
      expect(r.reply).not.toContain("[produk:");
      // Hanya id dari grounding yang dipakai — id karangan model dibuang.
      expect(r.products.map((p) => p.id)).toEqual([kerapu.id]);

      // Format request benar: endpoint native, key hanya di header backend.
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://example.invalid/v1/models/gemini-3.5-flash:generateContent");
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test-key");
      expect(JSON.stringify(init.headers)).not.toContain("Bearer");
      const body = JSON.parse(String(init.body)) as {
        contents?: { role?: string }[];
        systemInstruction?: { parts?: { text?: string }[] };
      };
      expect(Array.isArray(body.contents)).toBe(true);
      expect(body.contents?.every((c) => c.role === "user" || c.role === "model")).toBe(true);
      expect(body.systemInstruction?.parts?.length).toBeGreaterThan(0);
      // API key TIDAK PERNAH masuk badan permintaan.
      expect(String(init.body)).not.toContain("AIza-test-key");
    } finally {
      vi.unstubAllGlobals();
      if (prev.key !== undefined) process.env.GEMINI_API_KEY = prev.key;
      else delete process.env.GEMINI_API_KEY;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("pertanyaan hitungan → JALUR DIRECT dari section: tanpa provider, angka tetap tampil", async () => {
    // Routing baru: hitungan dijawab langsung dari data (bukan lagi menunggu
    // AI) — inilah yang dulu memakan timeout 90 detik untuk "berapa jumlah…".
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk pertanyaan hitungan");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "AIza-test";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    try {
      const r = await generateReply({
        message: "Berapa jumlah penjual?",
        history: [],
        products: [],
        sections: [countSection],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.source).toBe("fallback");
      expect(r.fallbackReason).toBe("direct");
      expect(r.reply).toContain("3 penjual terdaftar");
    } finally {
      vi.unstubAllGlobals();
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("query berfilter (subjek+harga) → DETERMINISTIK: tanpa panggil provider, format komposer", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk query berfilter");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "AIza-test";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    try {
      const r = await generateReply({
        message: "hasil laut di bawah 50000",
        history: [],
        products: [cumi],
        sections: [catalogSection],
        filters: {
          price: { max: 50000, maxExclusive: true },
          subject: { phrase: "hasil laut", mode: "category", value: "Hasil Laut" },
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.source).toBe("fallback");
      expect(r.products.map((p) => p.name)).toEqual(["Cumi-cumi Ring Segar (500 gr)"]);
      expect(r.reply).toContain("Menampilkan 1 produk yang cocok");
      expect(r.reply).toContain("di bawah Rp50.000");
      expect(r.reply).not.toContain("Ringkasan katalog");
    } finally {
      vi.unstubAllGlobals();
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("query berfilter hasil kosong → DETERMINISTIK 'tidak ada memenuhi filter' (bukan karangan model)", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk query berfilter");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const prev = { key: process.env.AI_API_KEY };
    process.env.AI_API_KEY = "AIza-test";
    try {
      const r = await generateReply({
        message: "udang di bawah 10000",
        history: [],
        products: [],
        sections: [],
        filters: {
          price: { max: 10000, maxExclusive: true },
          subject: { phrase: "udang", mode: "name", value: "udang" },
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.source).toBe("fallback");
      expect(r.products).toEqual([]);
      expect(r.reply).toContain("Tidak ada produk udang yang memenuhi");
    } finally {
      vi.unstubAllGlobals();
      process.env.AI_API_KEY = prev.key;
    }
  });

  it("sapaan tanpa data → jawaban ramah instan, TANPA provider & TANPA query", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk sapaan");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "AIza-test";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    try {
      const r = await generateReply({
        message: "Halo, apa yang bisa kamu bantu?",
        history: [],
        products: [],
        sections: [],
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(r.source).toBe("fallback");
      expect(r.fallbackReason).toBe("direct");
      expect(r.reply).toContain("Mendung Tirta");
      expect(r.reply.length).toBeGreaterThan(20);
    } finally {
      vi.unstubAllGlobals();
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("streamReply — SSE native Gemini → delta mengalir, marker dibersihkan, done final", async () => {
    const chunk = (text: string): string =>
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
    // Sengaja potong marker di tengah antar-chunk → sanitizer harus menahannya
    // sehingga penampil TIDAK PERNAH memperlihatkan "[produk:…]" mentah.
    const sse =
      chunk("Stok Ikan Kerapu saat ini 4. [pro") +
      chunk(`duk:${kerapu.id}] Utamakan yang segar.`) +
      "data: [DONE]\n\n";
    const encoder = new TextEncoder();
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(encoder.encode(sse.slice(0, 40)));
              c.enqueue(encoder.encode(sse.slice(40)));
              c.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "AIza-test";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    try {
      const deltas: string[] = [];
      let final: { type: "done" | "failed"; result: AiChatResult } | null = null;
      for await (const ev of streamReply({
        message: "Ceritakan soal stok ikan kerapu untuk pembeli",
        history: [],
        products: [kerapu],
        sections: [],
      })) {
        if (ev.type === "delta") deltas.push(ev.text);
        else final = ev;
      }
      // Tidak ada delta yang memperlihatkan marker mentah.
      expect(deltas.join("")).not.toContain("[produk:");
      expect(deltas.length).toBeGreaterThan(0);
      expect(final?.type).toBe("done");
      expect(final?.result.source).toBe("ai");
      expect(final?.result.reply).toContain("Stok Ikan Kerapu saat ini 4.");
      expect(final?.result.reply).not.toContain("[produk:");
      expect(final?.result.products.map((p) => p.id)).toEqual([kerapu.id]);

      // Format request streaming: endpoint native SSE + key hanya di header.
      const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://example.invalid/v1/models/gemini-3.5-flash:streamGenerateContent?alt=sse");
      expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test");
      expect(String(init.body)).not.toContain("AIza-test");
    } finally {
      vi.unstubAllGlobals();
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("streamReply — provider 401 → SATU percobaan lalu event failed (fallback)", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "AIza-test-tidak-valid";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      let final: { type: "done" | "failed"; result: AiChatResult } | null = null;
      for await (const ev of streamReply({
        message: "Apa saja produk yang dijual di sini?",
        history: [],
        products: [],
        sections: [catalogSection],
      })) {
        if (ev.type !== "delta") final = ev;
      }
      // 4xx TIDAK di-retry (percobaan ulang tidak akan memperbaiki key).
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(final?.type).toBe("failed");
      expect(final?.result.source).toBe("fallback");
      expect(final?.result.fallbackReason).toBe("provider-error");
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).not.toContain("AIza-test-tidak-valid");
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("streamReply — pertanyaan berdata → SATU event done instan tanpa provider", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk jalur direct");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const events: { type: "done" | "failed"; result: AiChatResult }[] = [];
      for await (const ev of streamReply({
        message: "Berapa jumlah penjual?",
        history: [],
        products: [],
        sections: [countSection],
      })) {
        if (ev.type !== "delta") events.push(ev);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("done");
      expect(events[0].result?.fallbackReason).toBe("direct");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Routing cerdas: deteksi sapaan (tanpa AI)                          */
/* ------------------------------------------------------------------ */

describe("isGreetingMessage — sapaan/percakapan ringan", () => {
  it("sapaan murni & smalltalk asisten → true", () => {
    expect(isGreetingMessage("Halo")).toBe(true);
    expect(isGreetingMessage("hai")).toBe(true);
    expect(isGreetingMessage("Hi!")).toBe(true);
    expect(isGreetingMessage("Selamat pagi")).toBe(true);
    expect(isGreetingMessage("Halo, apa yang bisa kamu bantu?")).toBe(true);
    expect(isGreetingMessage("apa kabar?")).toBe(true);
    expect(isGreetingMessage("siapa kamu")).toBe(true);
    expect(isGreetingMessage("Terima kasih")).toBe(true);
    expect(isGreetingMessage("makasih banyak")).toBe(true);
  });

  it("pertanyaan berdata / umum → BUKAN sapaan (tetap ke jalur yang tepat)", () => {
    expect(isGreetingMessage("Halo, berapa jumlah penjual?")).toBe(false);
    expect(isGreetingMessage("Mengapa ikan laut kaya omega-3?")).toBe(false);
    expect(isGreetingMessage("Berapa stok ikan kerapu?")).toBe(false);
    expect(isGreetingMessage("")).toBe(false);
    expect(isGreetingMessage("halusinasi ikan laut")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Product Filter Parser (Multi-Kriteria)                             */
/* ------------------------------------------------------------------ */

describe("parseProductFilters — filter gabungan multi-kriteria", () => {
  it("menggabungkan harga, kategori, toko, dan sorting", () => {
    const filters = parseProductFilters("kategori ikan segar dari toko Budi di bawah 100000 termurah");
    expect(filters.price).toEqual({ max: 100000, maxExclusive: true });
    expect(filters.category).toBe("ikan segar");
    expect(filters.store).toBe("budi");
    expect(filters.sortBy).toBe("price_asc");
  });

  it("hanya filter harga jika tidak ada kriteria lain", () => {
    const filters = parseProductFilters("di bawah 50000");
    expect(filters.price).toEqual({ max: 50000, maxExclusive: true });
    expect(filters.category).toBeUndefined();
    expect(filters.store).toBeUndefined();
    expect(filters.sortBy).toBeUndefined();
  });

  it("reset ke undefined jika tidak ada filter", () => {
    const filters = parseProductFilters("halo apa kabar");
    expect(filters.price).toBeUndefined();
    expect(filters.category).toBeUndefined();
    expect(filters.store).toBeUndefined();
  });
});

describe("parseCategoryFilter � ekstraksi kategori dari bahasa Indonesia", () => {
  it("mengekstrak 'kategori ikan'", () => {
    expect(parseCategoryFilter("kategori ikan")).toBe("ikan");
  });

  it("mengekstrak 'jenis umpan'", () => {
    expect(parseCategoryFilter("jenis umpan")).toBe("umpan");
  });

  it("return null jika tidak ada penanda kategori", () => {
    expect(parseCategoryFilter("ikan segar")).toBeNull();
  });
});

describe("parseStoreFilter � ekstraksi nama toko", () => {
  it("mengekstrak 'dari toko Budi'", () => {
    expect(parseStoreFilter("dari toko Budi")).toBe("budi");
  });

  it("mengekstrak 'toko Pancing Jaya'", () => {
    expect(parseStoreFilter("toko Pancing Jaya")).toBe("pancing jaya");
  });

  it("return null jika tidak ada penanda toko", () => {
    expect(parseStoreFilter("ikan segar")).toBeNull();
  });
});

describe("parseSortOrder � preferensi urutan", () => {
  it("'termurah' ? price_asc", () => {
    expect(parseSortOrder("termurah")).toBe("price_asc");
  });

  it("'termahal' ? price_desc", () => {
    expect(parseSortOrder("termahal")).toBe("price_desc");
  });

  it("'rating tertinggi' ? rating", () => {
    expect(parseSortOrder("rating tertinggi")).toBe("rating");
  });

  it("tidak ada kata kunci sorting ? null", () => {
    expect(parseSortOrder("ikan segar")).toBeNull();
  });
});

describe("parseStockFilter � ketersediaan stok", () => {
  it("'yang tersedia' ? true", () => {
    expect(parseStockFilter("yang tersedia")).toBe(true);
  });

  it("'stok habis' ? false", () => {
    expect(parseStockFilter("stok habis")).toBe(false);
  });

  it("tidak jelas ? null", () => {
    expect(parseStockFilter("ikan segar")).toBeNull();
  });
});

describe("parseMinRating � filter rating minimal", () => {
  it("'rating di atas 4' ? 4", () => {
    expect(parseMinRating("rating di atas 4")).toBe(4);
  });

  it("'bintang 4 ke atas' ? 4", () => {
    expect(parseMinRating("bintang 4 ke atas")).toBe(4);
  });

  it("tidak ada ? null", () => {
    expect(parseMinRating("ikan segar")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Subjek produk — ekstraksi frasa, sinonim, validasi ke kategori      */
/* ------------------------------------------------------------------ */

describe("extractSubjectPhrase — ekstraksi subjek dari bahasa Indonesia", () => {
  it("'Produk hasil laut di bawah 50000' → 'hasil laut'", () => {
    expect(extractSubjectPhrase("Produk hasil laut di bawah 50000")).toBe("hasil laut");
  });

  it("'Hasil laut di atas 50000' → 'hasil laut'", () => {
    expect(extractSubjectPhrase("Hasil laut di atas 50000")).toBe("hasil laut");
  });

  it("'Ikan yang masih tersedia di bawah 100000' → 'ikan' (kata ketersediaan dibuang)", () => {
    expect(extractSubjectPhrase("Ikan yang masih tersedia di bawah 100000")).toBe("ikan");
  });

  it("'Umpan di bawah 75000' → 'umpan'", () => {
    expect(extractSubjectPhrase("Umpan di bawah 75000")).toBe("umpan");
  });

  it("'Alat pancing di atas 100000' → 'alat pancing'", () => {
    expect(extractSubjectPhrase("Alat pancing di atas 100000")).toBe("alat pancing");
  });

  it("frasa toko dibuang: 'Hasil laut dari toko Hasil Laut Pak Budi di atas 50000' → 'hasil laut'", () => {
    expect(
      extractSubjectPhrase("Hasil laut dari toko Hasil Laut Pak Budi di atas 50000"),
    ).toBe("hasil laut");
  });

  it("tanpa subjek: 'di bawah 50000' → null", () => {
    expect(extractSubjectPhrase("di bawah 50000")).toBeNull();
    expect(extractSubjectPhrase("di atas 50000")).toBeNull();
  });

  it("pertanyaan hitungan tetap mengekstrak subjek: 'berapa jumlah produk hasil laut?' → 'hasil laut'", () => {
    expect(extractSubjectPhrase("berapa jumlah produk hasil laut?")).toBe("hasil laut");
  });

  it("sorting dibuang dari subjek: 'umpan di bawah 75000 termurah' → 'umpan'", () => {
    expect(extractSubjectPhrase("umpan di bawah 75000 termurah")).toBe("umpan");
  });

  it("rujukan ber-imbuhan '-nya' → kata dasar (bukan frasa sampah)", () => {
    // Regresi Q13: "Berapa stoknya?" dulu jadi subjek name "stoknya" yang
    // mematikan katalog & menyaring konteks percakapan.
    expect(extractSubjectPhrase("Berapa stoknya?")).toBeNull();
    expect(extractSubjectPhrase("Yang tadi harganya berapa?")).toBeNull();
    expect(extractSubjectPhrase("Kerapunya masih ada?")).toBe("kerapu");
    expect(extractSubjectPhrase("Ikan yang stoknya habis?")).toBe("ikan");
  });

  it("atribut non-produk bukan subjek: 'Bagaimana status pesanan saya?' → null", () => {
    expect(extractSubjectPhrase("Bagaimana status pesanan saya?")).toBeNull();
  });

  it("kata berhenti pencarian bukan subjek (regresi 'Ada produk apa saja?')", () => {
    // Regresi: frasa "apa"/"aja"/"coba kasih lihat" dulu lolos jadi subjek
    // name-mode → pencarian 0 baris → default telusuri katalog mati → AI
    // kehilangan konteks dan mengarang "tidak ada produk".
    expect(extractSubjectPhrase("Ada produk apa saja?")).toBeNull();
    expect(extractSubjectPhrase("Jual apa aja?")).toBeNull();
    expect(extractSubjectPhrase("Coba kasih lihat semua barang.")).toBeNull();
    expect(extractSubjectPhrase("Produk yang mana?")).toBeNull();
    // Konten nyata TETAP jadi subjek (kata bermakna bukan stopword).
    expect(extractSubjectPhrase("Adakah perahu?")).toBe("perahu");
    expect(extractSubjectPhrase("Ikan kerapu yang tersedia?")).toBe("ikan kerapu");
  });
});

describe("matchSubjectToCategories — validasi subjek ke kategori aktual", () => {
  const cats = ["Alat Pancing", "Umpan", "Hasil Laut"];

  it("exact match menang", () => {
    expect(matchSubjectToCategories("hasil laut", cats)).toEqual({ value: "Hasil Laut" });
    expect(matchSubjectToCategories("alat pancing", cats)).toEqual({ value: "Alat Pancing" });
  });

  it("parsial dua arah ('laut' → kategori yang mengandungnya)", () => {
    expect(matchSubjectToCategories("laut", cats)).toEqual({ value: "Hasil Laut" });
    expect(matchSubjectToCategories("pancing", cats)).toEqual({ value: "Alat Pancing" });
  });

  it("tanpa kategori cocok → null (bukan dipaksa)", () => {
    expect(matchSubjectToCategories("ikan", cats)).toBeNull();
  });

  it(">1 kandidat → ambiguous (wajib klarifikasi, jangan menebak)", () => {
    const r = matchSubjectToCategories("hasil", ["Hasil Laut", "Hasil Pantai"]);
    expect(r).toEqual({ ambiguous: ["Hasil Laut", "Hasil Pantai"] });
  });
});

describe("canonicalSubject — sinonim aman ke entitas yang ada", () => {
  it("sinonim kategori/menuju kategori", () => {
    expect(canonicalSubject("seafood")).toBe("hasil laut");
    expect(canonicalSubject("pancing")).toBe("alat pancing");
    expect(canonicalSubject("lure")).toBe("umpan");
  });

  it("sinonim nama produk", () => {
    expect(canonicalSubject("cumi-cumi")).toBe("cumi");
    expect(canonicalSubject("ikan segar")).toBe("ikan");
    expect(canonicalSubject("sotong")).toBe("cumi");
  });

  it("istilah tak dikenal tidak diubah", () => {
    expect(canonicalSubject("zebra")).toBe("zebra");
  });
});

describe("describePriceFilterText & isSingleProductQuestion", () => {
  it("deskripsi operator harga untuk jawaban", () => {
    expect(describePriceFilterText({ max: 50000, maxExclusive: true })).toBe("di bawah Rp50.000");
    expect(describePriceFilterText({ max: 50000 })).toBe("maksimal Rp50.000");
    expect(describePriceFilterText({ min: 50000 })).toBe("minimal Rp50.000");
    expect(describePriceFilterText({ min: 30000, max: 50000 })).toBe(
      "antara Rp30.000 dan Rp50.000",
    );
    expect(describePriceFilterText(undefined)).toBeNull();
  });

  it("pertanyaan atribut SATU produk vs pertanyaan filter/list", () => {
    expect(isSingleProductQuestion("berapa stok ikan kerapu?")).toBe(true);
    expect(isSingleProductQuestion("Berapa harga ikan kerapu?")).toBe(true);
    expect(isSingleProductQuestion("ulasan ikan kerapu")).toBe(true);
    expect(isSingleProductQuestion("hasil laut di bawah 50000")).toBe(false);
    expect(isSingleProductQuestion("ikan di atas 100000")).toBe(false);
  });
});

describe("extractKeywords — membuang angka & kata filter (bukan keyword)", () => {
  it("frasa harga murni → tanpa kata kunci", () => {
    expect(extractKeywords("di bawah 50000")).toEqual([]);
    expect(extractKeywords("di atas 50000")).toEqual([]);
    expect(extractKeywords("maksimal 50 ribu")).toEqual([]);
  });

  it("kata filter lain (harga/stok/tersedia) tidak jadi keyword", () => {
    expect(extractKeywords("harga stok tersedia")).toEqual([]);
  });

  it("subjek tetap jadi keyword (dibersihkan kemudian oleh pemanggil bila perlu)", () => {
    expect(extractKeywords("hasil laut di bawah 50000")).toEqual(["hasil", "laut"]);
  });

  it("rujukan '-nya' dinormalkan ke kata dasar lalu dibuang bila stopword", () => {
    expect(extractKeywords("Berapa stoknya?")).toEqual([]);
    expect(extractKeywords("Kerapunya masih ada?")).toEqual(["kerapu"]);
  });
});

/* ------------------------------------------------------------------ */
/* Fallback filter subjek+harga — daftar terfilter, bukan ringkasan    */
/* ------------------------------------------------------------------ */

const joran: AiProduct = {
  id: "a1b2c3d4-1111-4222-8333-444455556666",
  name: "Joran Tegek Carbon 4.5m",
  price: 150000,
  stock: 20,
  image: null,
  storeName: "Pancing Jaya Abadi",
  categoryName: "Alat Pancing",
  rating: 0,
  ratingCount: 0,
  status: "AVAILABLE",
};

const subjectHasilLaut: ProductFilter["subject"] = {
  phrase: "hasil laut",
  mode: "category",
  value: "Hasil Laut",
};

describe("fallbackResult — filter subjek + harga (daftar terfilter, bukan ringkasan katalog)", () => {
  it("'hasil laut di bawah 50000' → hanya produk hasil laut <50k, TANPA ringkasan katalog", () => {
    const r = fallbackResult({
      message: "hasil laut di bawah 50000",
      products: [kerapu, cumi, minnow, joran],
      sections: [catalogSection], // ringkasan katalog ADA di konteks tapi TIDAK boleh tampil
      generatedAt: GEN_AT,
      filters: { price: { max: 50000, maxExclusive: true }, subject: subjectHasilLaut },
    });
    expect(r.products.map((p) => p.name)).toEqual(["Cumi-cumi Ring Segar (500 gr)"]);
    expect(r.reply).toContain("Cumi-cumi Ring Segar (500 gr)");
    expect(r.reply).not.toContain("Ikan Kerapu");
    expect(r.reply).not.toContain("Umpan Minnow");
    expect(r.reply).not.toContain("Joran Tegek");
    expect(r.reply).not.toContain("Ringkasan katalog");
    expect(r.reply).not.toContain("Total produk");
    expect(r.reply).toContain("di bawah Rp50.000");
    expect(r.reply).toContain("Menampilkan 1 produk yang cocok");
  });

  it("'hasil laut di atas 50000' → hanya produk hasil laut >50k", () => {
    const r = fallbackResult({
      message: "hasil laut di atas 50000",
      products: [kerapu, cumi, minnow, joran],
      sections: [],
      generatedAt: GEN_AT,
      filters: { price: { min: 50000 }, subject: subjectHasilLaut },
    });
    expect(r.products.map((p) => p.name)).toEqual(["Ikan Kerapu Macan Segar (1 Kg)"]);
    expect(r.reply).not.toContain("Cumi-cumi");
    expect(r.reply).toContain("minimal Rp50.000");
  });

  it("subjek mode nama → hanya produk yang NAMANYA cocok (deskripsi kebetulan tidak ikut)", () => {
    const r = fallbackResult({
      message: "ikan di bawah 100000",
      products: [kerapu, cumi, minnow],
      sections: [],
      generatedAt: GEN_AT,
      filters: {
        price: { max: 100000, maxExclusive: true },
        subject: { phrase: "ikan", mode: "name", value: "ikan" },
      },
    });
    // Minnow menyebut "ikan" di deskripsi tapi TIDAK di nama → tidak boleh muncul
    expect(r.products.map((p) => p.name)).toEqual(["Ikan Kerapu Macan Segar (1 Kg)"]);
    expect(r.reply).not.toContain("Umpan Minnow");
  });

  it("subjek + harga + toko digabung (AND) — contoh: toko Hasil Laut Pak Budi >50k", () => {
    const r = fallbackResult({
      message: "Hasil laut dari toko Hasil Laut Pak Budi di atas 50000",
      products: [kerapu, cumi, minnow, joran],
      sections: [],
      generatedAt: GEN_AT,
      filters: {
        price: { min: 50000 },
        subject: subjectHasilLaut,
        store: "hasil laut pak budi",
      },
    });
    expect(r.products.map((p) => p.name)).toEqual(["Ikan Kerapu Macan Segar (1 Kg)"]);
  });

  it("hasil kosong → 'tidak ada produk memenuhi filter' (BUKAN 'katalog kosong')", () => {
    const r = fallbackResult({
      message: "hasil laut di atas 900000",
      products: [kerapu, cumi, minnow, joran],
      sections: [catalogSection],
      generatedAt: GEN_AT,
      filters: { price: { min: 900000 }, subject: subjectHasilLaut },
    });
    expect(r.products).toEqual([]);
    expect(r.reply).toContain("Tidak ada produk hasil laut yang memenuhi");
    expect(r.reply).not.toContain("katalog kosong");
    expect(r.reply).not.toContain("Total produk non-hidden");
  });

  it("subjek ambigu → minta klarifikasi pilihan kategori (bukan menebak)", () => {
    const r = fallbackResult({
      message: "hasil di bawah 50000",
      products: [],
      sections: [],
      generatedAt: GEN_AT,
      filters: { price: { max: 50000, maxExclusive: true } },
      subjectAmbiguity: { phrase: "hasil", options: ["Hasil Laut", "Hasil Pantai"] },
    });
    expect(r.products).toEqual([]);
    expect(r.reply).toContain("bisa merujuk ke beberapa kategori");
    expect(r.reply).toContain("Hasil Laut");
    expect(r.reply).toContain("Hasil Pantai");
  });

  it("pertanyaan hitungan + filter → jawaban HANYA angka (bukan daftar produk)", () => {
    const countSection: ContextSection = {
      key: "count",
      label: 'Jumlah produk "hasil laut" sesuai filter (data aktual)',
      scope: "publik",
      asOf: GEN_AT,
      text: "Saat ini terdapat 1 produk hasil laut dengan harga di bawah Rp50.000 di katalog.",
    };
    const r = fallbackResult({
      message: "berapa jumlah produk hasil laut di bawah 50000?",
      products: [cumi],
      sections: [countSection],
      generatedAt: GEN_AT,
      filters: { price: { max: 50000, maxExclusive: true }, subject: subjectHasilLaut },
    });
    expect(r.reply).toContain("1 produk hasil laut");
    expect(r.products).toEqual([]);
    expect(r.reply).not.toContain("Ringkasan katalog");
  });
});

/* ------------------------------------------------------------------ */
/* CRITICAL FIX — intent non-katalog TIDAK PERNAH dijawab produk       */
/* ------------------------------------------------------------------ */

describe("fallback intent non-katalog (hapus fallback salah)", () => {
  const revenueSection: ContextSection = {
    key: "revenue",
    label: "Total pendapatan toko (data aktual)",
    scope: "toko-sendiri",
    asOf: GEN_AT,
    text:
      "Total pendapatan toko Anda adalah Rp1.250.000 berdasarkan pesanan dengan status yang " +
      "memenuhi kriteria perhitungan (Diproses, Dikirim, Siap Diambil, dan Selesai), " +
      "pada periode seluruh periode data (sejak awal catatan transaksi).",
  };
  const buyerRevenueLimit: ContextSection = {
    key: "revenue",
    label: "Keterbatasan data pendapatan (admin)",
    scope: "admin",
    asOf: GEN_AT,
    text:
      "Pendapatan adalah data internal marketplace — hanya tersedia untuk admin " +
      "(pendapatan marketplace) dan penjual (pendapatan toko sendiri).",
  };

  it("REVENUE + section pendapatan → nominal + status + periode, TANPA produk", () => {
    const r = fallbackResult({
      message: "Berapa total pendapatan?",
      products: [kerapu], // konteks produk tidak boleh menyusup ke jawaban pendapatan
      contextProducts: [kerapu],
      sections: [revenueSection],
      generatedAt: GEN_AT,
      intent: "REVENUE",
    });
    expect(r.reply).toContain("Rp1.250.000");
    expect(r.reply).toMatch(/Diproses, Dikirim, Siap Diambil/);
    expect(r.reply).toMatch(/periode/);
    expect(r.reply).not.toContain("Ikan Kerapu");
    expect(r.reply).not.toMatch(/Berikut produk|Rekomendasi/i);
    expect(r.products).toEqual([]);
  });

  it("REVENUE gagal → pesan kegagalan data pendapatan (katalog tidak dipakai, angka tidak dikarang)", () => {
    const r = fallbackResult({
      message: "Berapa total pendapatan?",
      products: [kerapu, cumi],
      contextProducts: [kerapu],
      sections: [catalogSection], // ringkasan katalog DIKUCILKAN untuk intent pendapatan
      generatedAt: GEN_AT,
      intent: "REVENUE",
    });
    expect(r.reply).toContain("Data pendapatan belum dapat diambil");
    expect(r.reply).not.toMatch(/Berikut produk|Rekomendasi|Ringkasan katalog/i);
    expect(r.reply).not.toMatch(/Rp\d/); // tidak ada angka karangan
    expect(r.products).toEqual([]);
  });

  it("REVENUE peran BUYER → penolakan peran jujur, tanpa angka pendapatan", () => {
    const r = fallbackResult({
      message: "Berapa pendapatan toko saya?",
      products: [],
      sections: [buyerRevenueLimit],
      generatedAt: GEN_AT,
      intent: "REVENUE",
    });
    expect(r.reply).toMatch(/hanya tersedia untuk admin/i);
    expect(r.reply).not.toMatch(/Rp\d/);
    expect(r.products).toEqual([]);
  });

  it("ORDER_COUNT tanpa section → pesan jumlah pesanan yang jujur, bukan katalog", () => {
    const r = fallbackResult({
      message: "Berapa jumlah pesanan?",
      products: [joran],
      sections: [],
      generatedAt: GEN_AT,
      intent: "ORDER_COUNT",
    });
    expect(r.reply).toContain("Jumlah pesanan belum dapat diambil");
    expect(r.reply).not.toMatch(/Berikut produk|Rp\d/i);
    expect(r.products).toEqual([]);
  });

  /* ---- Pemisahan role vs akun (USER_ROLES / ROLE_PERMISSION / USER_LIST) ---- */
  const rolesSection: ContextSection = {
    key: "roles",
    label: "Role pengguna & hak akses (definisi aplikasi)",
    scope: "publik",
    asOf: GEN_AT,
    text:
      "Role pengguna di Mendung Tirta ada 3: ADMIN, SELLER (Penjual), BUYER (Pembeli).\n\n" +
      "ADMIN (Administrator):\n- Mengelola pengguna\n\n" +
      "SELLER (Penjual):\n- Mengelola toko\n\n" +
      "BUYER (Pembeli):\n- Melihat dan mencari produk",
  };
  const accountSection: ContextSection = {
    key: "account",
    label: "Informasi akun Anda",
    scope: "milik-sendiri",
    asOf: GEN_AT,
    text: "Nama: Andi Kurniawan\nEmail: andi@contoh.id\nPeran: Pembeli",
  };

  it("USER_ROLES → jawaban role, TANPA profil akun & TANPA produk", () => {
    const r = fallbackResult({
      message: "Ada apa saja role pengguna?",
      products: [kerapu],
      contextProducts: [kerapu],
      // Profil akun TIDAK BOLEH menyusup walau kebetulan ada di sections.
      sections: [rolesSection, accountSection],
      generatedAt: GEN_AT,
      intent: "USER_ROLES",
    });
    expect(r.reply).toContain("ADMIN (Administrator)");
    expect(r.reply).toContain("SELLER (Penjual)");
    expect(r.reply).toContain("BUYER (Pembeli)");
    expect(r.reply).not.toContain("Andi Kurniawan");
    expect(r.reply).not.toContain("andi@contoh.id");
    expect(r.products).toEqual([]);
    expect(r.reply).not.toMatch(/Berikut produk|Rekomendasi/i);
  });

  it("ROLE_PERMISSION → hak akses role saja, tanpa profil akun", () => {
    const dutySection: ContextSection = {
      key: "roles",
      label: "Hak akses role (definisi aplikasi)",
      scope: "publik",
      asOf: GEN_AT,
      text:
        "Hak akses ADMIN (Administrator) di Mendung Tirta:\n" +
        "- Mengelola pengguna\n- Memantau pesanan dan transaksi",
    };
    const r = fallbackResult({
      message: "Apa tugas admin?",
      products: [],
      sections: [dutySection, accountSection],
      generatedAt: GEN_AT,
      intent: "ROLE_PERMISSION",
    });
    expect(r.reply).toContain("Hak akses ADMIN");
    expect(r.reply).toContain("Mengelola pengguna");
    expect(r.reply).not.toContain("Andi Kurniawan");
    expect(r.products).toEqual([]);
  });

  it("USER_LIST (admin) → daftar pengguna dari data; tanpa email & produk", () => {
    const listSection: ContextSection = {
      key: "userlist",
      label: "Daftar pengguna (3 akun)",
      scope: "admin",
      asOf: GEN_AT,
      text: "Daftar pengguna terdaftar (3):\n- Andi (Penjual)\n- Budi (Pembeli)\n- Citra (Admin)",
    };
    const r = fallbackResult({
      message: "Daftar pengguna",
      products: [kerapu],
      sections: [listSection],
      generatedAt: GEN_AT,
      intent: "USER_LIST",
    });
    expect(r.reply).toContain("Daftar pengguna terdaftar (3)");
    expect(r.reply).not.toMatch(/@/); // tanpa email (PII)
    expect(r.products).toEqual([]);
  });

  it("USER_LIST tanpa section → pesan penolakan/kegagalan jujur, bukan katalog", () => {
    const r = fallbackResult({
      message: "Daftar pengguna",
      products: [joran],
      sections: [],
      generatedAt: GEN_AT,
      intent: "USER_LIST",
    });
    expect(r.reply).toContain("Daftar pengguna belum dapat diambil");
    expect(r.reply).not.toMatch(/Berikut produk|Rekomendasi/i);
    expect(r.products).toEqual([]);
  });

  it("USER_ROLES tanpa section → pesan kegagalan role, bukan katalog", () => {
    const r = fallbackResult({
      message: "Ada apa saja role pengguna?",
      products: [kerapu, cumi],
      sections: [],
      generatedAt: GEN_AT,
      intent: "USER_ROLES",
    });
    expect(r.reply).toContain("Informasi role dan hak aksesnya belum dapat dimuat");
    expect(r.reply).not.toMatch(/Berikut produk|Rekomendasi|Rp\d/i);
    expect(r.products).toEqual([]);
  });

  it("intent produk TETAP boleh menampilkan produk (GENERAL tidak terdampak)", () => {
    const r = fallbackResult({
      message: "Ada ikan kerapu?",
      products: [kerapu],
      sections: [],
      generatedAt: GEN_AT,
      intent: "PRODUCT_SEARCH",
    });
    expect(r.products.map((p) => p.name)).toEqual(["Ikan Kerapu Macan Segar (1 Kg)"]);
  });

  it("generateReply REVENUE → jalur direct instan, TANPA panggilan provider & TANPA produk", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk intent pendapatan");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await generateReply({
        message: "Berapa total pendapatan?",
        history: [],
        products: [kerapu],
        contextProducts: [kerapu],
        sections: [revenueSection],
        intent: "REVENUE",
      });
      expect(r.reply).toContain("Rp1.250.000");
      expect(r.fallbackReason).toBe("direct");
      expect(r.products).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("generateReply REVENUE tanpa section → kegagalan jujur, provider & produk tetap tidak disentuh", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk intent pendapatan");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await generateReply({
        message: "Berapa total pendapatan?",
        history: [],
        products: [kerapu],
        sections: [],
        intent: "REVENUE",
      });
      expect(r.reply).toContain("Data pendapatan belum dapat diambil");
      expect(r.fallbackReason).toBe("direct");
      expect(r.products).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("generateReply USER_ROLES → jalur direct instan, TANPA provider & TANPA produk walau riwayat memuat produk", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("provider tidak boleh dipanggil untuk intent role");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await generateReply({
        message: "Ada apa saja role pengguna?",
        history: [
          { role: "user", content: "Ada ikan kerapu?" },
          { role: "assistant", content: "Ikan Kerapu Macan Segar (1 Kg) — Rp85.000 (stok 15)" },
        ],
        products: [kerapu],
        contextProducts: [kerapu], // riwayat produk tidak boleh menyusup ke jawaban role
        sections: [rolesSection],
        intent: "USER_ROLES",
      });
      expect(r.reply).toContain("ADMIN (Administrator)");
      expect(r.reply).not.toContain("Ikan Kerapu");
      expect(r.fallbackReason).toBe("direct");
      expect(r.products).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sapaan murni dijawab perkenalan diri WALAU riwayat memuat produk", async () => {
    const r = await generateReply({
      message: "Siapa kamu?",
      history: [
        { role: "user", content: "Ada ikan kerapu?" },
        {
          role: "assistant",
          content: "Ikan Kerapu Macan Segar (1 Kg) — Rp85.000 (stok 15)",
        },
      ],
      products: [kerapu],
      contextProducts: [kerapu, cumi], // riwayat produk TIDAK boleh membajak sapaan
      sections: [],
    });
    expect(r.reply).toMatch(/Mendung Tirta/);
    expect(r.products).toEqual([]);
    expect(r.fallbackReason).toBe("direct");
  });

  it("pesan ber-data dengan awalan sapaan TETAP bukan sapaan (jalur data menang)", async () => {
    const r = await generateReply({
      message: "Halo, berapa jumlah penjual?",
      history: [],
      products: [kerapu],
      sections: [countSection],
      intent: "SELLER_INFO",
    });
    expect(r.reply).toContain("penjual");
    expect(r.reply).not.toMatch(/^Halo!/);
    expect(r.fallbackReason).toBe("direct");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractKeywords,
  fallbackResult,
  generateReply,
  parsePriceFilter,
  filterProductsByPrice,
  productMatchesPriceFilter,
  type AiProduct,
  type PriceFilter,
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

  it("tanpa AI_API_KEY → fallback + tidak pernah menampilkan key", async () => {
    const prevKey = process.env.AI_API_KEY;
    delete process.env.AI_API_KEY;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const r = await generateReply({
        message: "Berapa stok ikan kerapu?",
        history: [],
        products: [kerapu],
        sections: [],
        focus: kerapu,
      });
      expect(r.source).toBe("fallback");
      expect(r.reply).toContain("Ikan Kerapu Macan Segar (1 Kg)");
      const logged = info.mock.calls.flat().join(" ");
      expect(logged).not.toMatch(/nvapi-|Bearer|sk-/i);
    } finally {
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
        message: "Berapa stok ikan kerapu?",
        history: [],
        products: [kerapu],
        sections: [],
        focus: kerapu,
      });
      expect(r.source).toBe("fallback");
      expect(r.reply).toContain("Ikan Kerapu Macan Segar (1 Kg)");
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("[ai]");
      expect(logged).not.toContain("test-key-rahasia-jangan-log");
    } finally {
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
      process.env.AI_MODEL = prev.model;
      process.env.AI_TIMEOUT_MS = prev.timeout;
    }
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
    process.env.AI_API_KEY = "nvapi-test-tidak-valid";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await generateReply({
        message: "halo",
        history: [],
        products: [],
        sections: [],
      });
      expect(r.source).toBe("fallback");
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("provider HTTP 401");
      expect(logged).not.toContain("nvapi-test-tidak-valid");
    } finally {
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("respons AI valid → sumber 'ai', marker [produk:id] divalidasi ke grounding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: `Stok Ikan Kerapu saat ini 4. [produk:${kerapu.id}] [produk:00000000-0000-0000-0000-000000000000]`,
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "nvapi-test";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    try {
      const r = await generateReply({
        message: "Berapa stok ikan kerapu?",
        history: [],
        products: [kerapu],
        sections: [],
        focus: kerapu,
      });
      expect(r.source).toBe("ai");
      expect(r.reply).toContain("Stok Ikan Kerapu saat ini 4");
      expect(r.reply).not.toContain("[produk:");
      // Hanya id dari grounding yang dipakai — id karangan model dibuang.
      expect(r.products.map((p) => p.id)).toEqual([kerapu.id]);
    } finally {
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });

  it("prompt hitungan → menyertakan angka section + instruksi tanpa statistik lain", async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        bodies.push(JSON.parse(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: "Saat ini terdapat 3 penjual terdaftar di Mendung Tirta." } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const prev = { key: process.env.AI_API_KEY, base: process.env.AI_BASE_URL };
    process.env.AI_API_KEY = "nvapi-test";
    process.env.AI_BASE_URL = "https://example.invalid/v1";
    try {
      const r = await generateReply({
        message: "Berapa jumlah penjual?",
        history: [],
        products: [],
        sections: [countSection],
      });
      expect(r.source).toBe("ai");
      expect(bodies).toHaveLength(1);
      const systemText = bodies[0].messages.map((m) => m.content).join("\n");
      // Data hitungan dari DB & instruksi eksplisit agar tidak menambah statistik lain.
      expect(systemText).toContain("Saat ini terdapat 3 penjual terdaftar di Mendung Tirta.");
      expect(systemText).toMatch(/JANGAN tambahkan statistik atau daftar lain/);
      expect(systemText).toMatch(/HANYA dengan angka dari section/);
    } finally {
      process.env.AI_API_KEY = prev.key;
      process.env.AI_BASE_URL = prev.base;
    }
  });
});

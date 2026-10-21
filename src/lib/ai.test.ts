import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractKeywords,
  fallbackResult,
  generateReply,
  type AiProduct,
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
});

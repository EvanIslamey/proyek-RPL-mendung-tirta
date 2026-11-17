import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Uji routing planReply/generateReply — jaring pengaman intent katalog
 * TANPA hasil query tidak boleh diteruskan ke provider dengan konteks
 * kosong (regresi "Ada produk apa saja?" yang dulu dijawab Gemini dengan
 * karangan "tidak ada produk" padahal katalog berisi).
 *
 * DB di-mock di sini; verifikasi terhadap DB aktual (jumlah baris vs
 * jawaban chatbot) ada di uji live scripts/test-chatbot-dataset.mts.
 */

vi.mock("@/lib/prisma", () => ({
  prisma: {
    category: { findMany: vi.fn() },
    product: { count: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { generateReply } from "@/lib/ai";
import { invalidateAiCache } from "@/lib/ai-cache";

const ROW = {
  id: "p1",
  name: "Ikan Kerapu Macan Segar (1 Kg)",
  price: 85000,
  stock: 15,
  image: null,
  storeName: "Hasil Laut Pak Budi",
  categoryName: "Hasil Laut",
  rating: 4.5,
  ratingCount: 3,
  status: "AVAILABLE",
};

beforeEach(() => {
  vi.clearAllMocks();
  invalidateAiCache();
});

describe("planReply 3b — intent katalog tanpa hasil tidak pernah ke AI kosong", () => {
  it("pertanyaan generik + katalog berisi → daftar deterministik (filtered)", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([ROW]);
    const r = await generateReply({
      message: "Ada produk apa saja?",
      history: [],
      products: [],
      sections: [],
      intent: "PRODUCT_SEARCH",
    });
    expect(r.source).toBe("fallback");
    expect(r.fallbackReason).toBe("filtered");
    expect(r.products).toHaveLength(1);
    expect(r.products[0]?.name).toBe("Ikan Kerapu Macan Segar (1 Kg)");
    expect(r.reply).toContain("Ikan Kerapu Macan Segar (1 Kg)");
    // Query telusuri katalog BENAR-BENAR dijalankan sebelum menyatakan hasil.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("katalog benar-benar kosong → pesan jujur dari hasil query, bukan halusinasi", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
    const r = await generateReply({
      message: "Ada produk apa saja?",
      history: [],
      products: [],
      sections: [],
      intent: "PRODUCT_SEARCH",
    });
    expect(r.source).toBe("fallback");
    expect(r.fallbackReason).toBe("direct");
    expect(r.reply).toContain("belum menemukan data");
    expect(r.products).toHaveLength(0);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("pertanyaan spesifik yang 0 hasil → jujur, TANPA membanjiri semua produk", async () => {
    const r = await generateReply({
      message: "cari produk xylophone",
      history: [],
      products: [],
      sections: [],
      intent: "PRODUCT_SEARCH",
    });
    expect(r.source).toBe("fallback");
    expect(r.fallbackReason).toBe("direct");
    expect(r.reply).toContain("belum menemukan data");
    // Pencarian spesifik sudah dijalankan konteks (0 baris) — tidak ada
    // telusuri default yang membalikkan jawaban jadi daftar semua produk.
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("produk terkumpul dari konteks → jalur AI yang SUDAH berkonteks tidak disentuh", async () => {
    // products terisi (mis. hasil pencarian keyword) → tidak kena 3b;
    // tanpa key AI → fallback no-ai-config (perilaku lama dipertahankan).
    const prevGem = process.env.GEMINI_API_KEY;
    const prevKey = process.env.AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.AI_API_KEY;
    try {
      const r = await generateReply({
        message: "joran seperti apa yang bagus?",
        history: [],
        products: [ROW],
        sections: [],
        intent: "PRODUCT_SEARCH",
      });
      expect(r.fallbackReason).toBe("no-ai-config");
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    } finally {
      if (prevGem !== undefined) process.env.GEMINI_API_KEY = prevGem;
      if (prevKey !== undefined) process.env.AI_API_KEY = prevKey;
    }
  });
});

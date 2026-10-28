import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Test lapisan DB subjek/filter dengan Prisma ter-mock:
 * - resolveProductSubject: validasi frasa ke kategori AKTUAL + error ≠ subjek kosong
 * - countCatalog: hitungan berfilter (parameterized) + error ≠ 0
 * - searchCatalog: subjek DAN harga dalam SATU WHERE (AND) + visibilitas terkurung
 *   (regresi bug precedence OR/AND).
 *
 * Query DB aktual (tanpa mock) diverifikasi lewat uji live terhadap server dev.
 */

vi.mock("@/lib/prisma", () => ({
  prisma: {
    category: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { resolveProductSubject, countCatalog, searchCatalog } from "@/lib/ai";

/** Kategori aktual (selaras dengan prisma/seed.ts) + 1 untuk uji ambigu. */
const CATS = ["Alat Pancing", "Hasil Laut", "Hasil Pantai", "Umpan"];

type SqlArg = { strings: readonly string[]; values: readonly unknown[] };
const asSql = (call: unknown): SqlArg => call as SqlArg;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveProductSubject — validasi ke data kategori aktual", () => {
  it("DB error DITOLAK (throw) — bukan subjek kosong/karangan", async () => {
    // Harus paling awal: sebelum cache kategori terisi oleh test sukses lain.
    vi.mocked(prisma.category.findMany).mockRejectedValueOnce(new Error("db down"));
    await expect(resolveProductSubject("hasil laut di bawah 50000")).rejects.toThrow("db down");
  });

  it("frasa cocok kategori → mode category dengan nama kategori AKTUAL", async () => {
    vi.mocked(prisma.category.findMany).mockResolvedValue(
      CATS.map((name) => ({ name })) as never,
    );
    const r = await resolveProductSubject("Hasil laut di atas 50000");
    expect(r.subject).toEqual({ phrase: "hasil laut", mode: "category", value: "Hasil Laut" });
    const r2 = await resolveProductSubject("Alat pancing di atas 100000");
    expect(r2.subject).toEqual({ phrase: "alat pancing", mode: "category", value: "Alat Pancing" });
  });

  it("tanpa kategori cocok → mode name (filter ketat nama produk)", async () => {
    const r = await resolveProductSubject("ikan di bawah 50000");
    expect(r.subject).toEqual({ phrase: "ikan", mode: "name", value: "ikan" });
    expect(r.ambiguous).toBeUndefined();
  });

  it("frasa yang bisa berarti >1 kategori → ambiguous (jangan menebak)", async () => {
    const r = await resolveProductSubject("hasil di bawah 50000");
    expect(r.subject).toBeNull();
    expect(r.ambiguous).toEqual(["Hasil Laut", "Hasil Pantai"]);
  });

  it("tanpa frasa subjek → null (filter harga saja tetap jalan)", async () => {
    const r = await resolveProductSubject("di bawah 50000");
    expect(r.subject).toBeNull();
  });
});

describe("countCatalog — hitungan berfilter (parameterized) & error ≠ 0", () => {
  it("mengembalikan angka aktual dari DB", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ n: "2" }]);
    const n = await countCatalog({
      subject: { phrase: "hasil laut", mode: "category", value: "Hasil Laut" },
      price: { max: 50000, maxExclusive: true },
    });
    expect(n).toBe(2);
    const sql = asSql(vi.mocked(prisma.$queryRaw).mock.calls[0][0]);
    expect(sql.strings.join("?")).toContain("COUNT(*)");
    expect(sql.strings.join("?")).toContain("p.price <");
    expect(sql.strings.join("?")).toContain("c.name ILIKE");
    expect(sql.values).toContain(50000);
    expect(sql.values).toContain("%Hasil Laut%");
  });

  it("kondisi hanya tersedia/terjual sesuai opsi kind", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ n: "1" }]);
    await countCatalog(
      { subject: { phrase: "ikan", mode: "name", value: "ikan" } },
      { onlyAvailable: true },
    );
    const sql = asSql(vi.mocked(prisma.$queryRaw).mock.calls[0][0]);
    expect(sql.strings.join("?")).toContain("p.status = 'AVAILABLE'");
    expect(sql.values).toContain("%ikan%");
  });

  it("DB error DITOLAK (throw) — tidak pernah diubah menjadi angka 0", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error("db down"));
    await expect(countCatalog({ price: { min: 50000 } })).rejects.toThrow("db down");
  });
});

describe("searchCatalog — AND subjek + harga dalam SATU WHERE (regresi precedence)", () => {
  it("subjek DAN harga dikirim sebagai kondisi AND + visibilitas terkurung kurung", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);
    await searchCatalog([], {
      subject: { phrase: "hasil laut", mode: "category", value: "Hasil Laut" },
      price: { max: 50000, maxExclusive: true },
    });
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalledTimes(1);
    const sql = asSql(vi.mocked(prisma.$queryRaw).mock.calls[0][0]);
    const text = sql.strings.join("?");
    // Klausa visibilitas WAJIB terkurung & jadi kondisi pertama yang ter-AND —
    // tanpa kurung, "A OR B AND C" membuat filter berikutnya terlewati
    // (precedence OR > AND).
    expect(text).toContain("WHERE (p.status <> 'HIDDEN') AND ");
    expect(text).not.toContain("OR (p.status <> 'HIDDEN')");
    expect(text).toContain("p.price <");
    expect(text).toContain("c.name ILIKE");
    expect(sql.values).toContain(50000);
    expect(sql.values).toContain("%Hasil Laut%");
  });

  it("subjek mode name → ILIKE pada nama produk (bukan kategori/deskripsi)", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([]);
    await searchCatalog([], {
      subject: { phrase: "ikan", mode: "name", value: "ikan" },
      price: { min: 100000 },
    });
    const sql = asSql(vi.mocked(prisma.$queryRaw).mock.calls[0][0]);
    const text = sql.strings.join("?");
    expect(text).toContain("p.name ILIKE");
    expect(sql.values).toContain("%ikan%");
    expect(sql.values).toContain(100000);
  });

  it("tanpa filter & tanpa keyword → tidak menjalankan query sama sekali", async () => {
    await searchCatalog([], {});
    expect(vi.mocked(prisma.$queryRaw)).not.toHaveBeenCalled();
  });
});

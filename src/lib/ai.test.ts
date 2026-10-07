import { describe, expect, it } from "vitest";
import { extractKeywords } from "@/lib/ai";

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

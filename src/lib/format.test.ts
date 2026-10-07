import { describe, expect, it } from "vitest";
import { formatDateId, formatRupiah } from "@/lib/format";

describe("formatRupiah", () => {
  it("format rupiah tanpa desimal", () => {
    expect(formatRupiah(0)).toContain("0");
    expect(formatRupiah(85000)).toContain("85.000");
    expect(formatRupiah(1500000)).toContain("1.500.000");
  });
});

describe("formatDateId", () => {
  it("menghasilkan tanggal format Indonesia", () => {
    const s = formatDateId(new Date("2026-10-07T00:00:00Z"));
    expect(s).toContain("2026");
    expect(s).toMatch(/Oktober|Okt/);
  });

  it("menerima string ISO", () => {
    expect(formatDateId("2026-01-15T00:00:00Z")).toContain("2026");
  });
});

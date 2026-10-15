import { describe, expect, it } from "vitest";
import { detectIntents } from "@/lib/ai-context";

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

  it("mendeteksi intent 'stats' untuk pertanyaan statistik admin", () => {
    expect(detectIntents("statistik marketplace")).toContain("stats");
    expect(detectIntents("jumlah pengguna platform")).toContain("stats");
  });

  it("mendeteksi intent 'lowstock' untuk pertanyaan stok menipis", () => {
    expect(detectIntents("stok menipis")).toContain("lowstock");
    expect(detectIntents("stok hampir habis")).toContain("lowstock");
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
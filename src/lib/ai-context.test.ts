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

  it("statistik jumlah penjual/pembeli terdeteksi intent stats", () => {
    expect(detectIntents("berapa jumlah penjual")).toContain("stats");
    expect(detectIntents("berapa jumlah pembeli")).toContain("stats");
    expect(detectIntents("jumlah toko aktif berapa")).toContain("stats");
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
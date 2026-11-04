/**
 * Unit test notifikasi — fungsi murni kebijakan pengiriman.
 * Fokus: TIDAK ada pengiriman ulang (Telegram) akibat retry email,
 * plus kebijakan penerima/format nomor kanal WhatsApp (Fonnte).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL_MAX_ATTEMPTS,
  WA_MAX_ATTEMPTS,
  buildWaMessage,
  emailAllowed,
  isE164,
  isIndonesiaMobile,
  maskPhone,
  parseOpsTargets,
  retryDelayMs,
  sanitizeEmailError,
  telegramGateAllows,
  telegramSendOnce,
} from "./notify";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("telegramSendOnce — anti duplikat akibat retry", () => {
  it("mengirim Telegram hanya pada percobaan pertama", () => {
    expect(telegramSendOnce(0)).toBe(true);
  });

  it("retry email (percobaan ke-2/ke-3) TIDAK mengirim ulang Telegram", () => {
    expect(telegramSendOnce(1)).toBe(false);
    expect(telegramSendOnce(2)).toBe(false);
    expect(telegramSendOnce(EMAIL_MAX_ATTEMPTS - 1)).toBe(false);
  });
});

describe("telegramGateAllows — gerbang panel Pengaturan Telegram", () => {
  it("tanpa baris konfigurasi (null/undefined) → perilaku lama: kanal tetap kirim", () => {
    expect(telegramGateAllows(null)).toBe(true);
    expect(telegramGateAllows(undefined)).toBe(true);
  });

  it("ada baris konfigurasi → mengikuti tombol Aktifkan/Nonaktifkan panel", () => {
    expect(telegramGateAllows(true)).toBe(true);
    expect(telegramGateAllows(false)).toBe(false);
  });
});

describe("emailAllowed — kebijakan preferensi", () => {
  it("email transaksional (essential) selalu diizinkan", () => {
    expect(emailAllowed(true, false)).toBe(true);
    expect(emailAllowed(undefined, false)).toBe(true);
  });

  it("email non-esensial mengikuti preferensi user", () => {
    expect(emailAllowed(false, true)).toBe(true);
    expect(emailAllowed(false, false)).toBe(false);
  });
});

describe("retryDelayMs — backoff terbatas", () => {
  it("percobaan pertama menunggu singkat, berikutnya lebih lama", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(99)).toBe(120_000);
  });
});

describe("sanitizeEmailError — tidak membocorkan rahasia", () => {
  it("menyamarkan bearer token & api key dalam pesan galat", () => {
    const out = sanitizeEmailError(new Error("401 Bearer nvapi-abcdef1234567890 failed api_key=abc123def456"));
    expect(out).not.toContain("nvapi-abcdef1234567890");
    expect(out).not.toContain("abc123def456");
    expect(out).toContain("***");
  });

  it("memotong pesan panjang (maks 200 karakter)", () => {
    const out = sanitizeEmailError(new Error("x".repeat(500)));
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("isIndonesiaMobile — validasi nomor profil WhatsApp", () => {
  it("menerima format internasional Indonesia (+628…)", () => {
    expect(isIndonesiaMobile("+6281234567890")).toBe(true);
    expect(isIndonesiaMobile("+6289876543210")).toBe(true);
  });

  it("menolak format lokal, asing, kosong, atau null", () => {
    expect(isIndonesiaMobile("081234567890")).toBe(false);
    expect(isIndonesiaMobile("6281234567890")).toBe(false);
    expect(isIndonesiaMobile("+627111222333")).toBe(false); // bukan awalan +628
    expect(isIndonesiaMobile("+12125551234")).toBe(false);
    expect(isIndonesiaMobile("")).toBe(false);
    expect(isIndonesiaMobile(null)).toBe(false);
    expect(isIndonesiaMobile(undefined)).toBe(false);
  });
});

describe("isE164 & parseOpsTargets — penerima operasional admin", () => {
  it("isE164 menerima nomor internasional generik", () => {
    expect(isE164("+6281234567890")).toBe(true);
    expect(isE164("+81312345678")).toBe(true);
    expect(isE164("0812")).toBe(false);
    expect(isE164("+081234567")).toBe(false);
  });

  it("memilah entri valid, membuang yang salah", () => {
    expect(parseOpsTargets("+628111111111,+628222222222")).toEqual([
      "+628111111111",
      "+628222222222",
    ]);
    expect(parseOpsTargets("  +628111111111 , 0812 , abc ")).toEqual(["+628111111111"]);
  });

  it("null/kosong/tanpa nomor valid → daftar kosong", () => {
    expect(parseOpsTargets(null)).toEqual([]);
    expect(parseOpsTargets(undefined)).toEqual([]);
    expect(parseOpsTargets("")).toEqual([]);
    expect(parseOpsTargets("bukan-nomor")).toEqual([]);
  });
});

describe("maskPhone — log aman tanpa nomor utuh", () => {
  it("menyamarkan bagian tengah nomor", () => {
    expect(maskPhone("+6281234567890")).toBe("62812***7890");
    expect(maskPhone("6289876543210")).toBe("62898***3210");
  });

  it("nomor sangat pendek disamarkan penuh", () => {
    expect(maskPhone("123")).toBe("•••");
    expect(maskPhone("+62")).toBe("•••");
  });
});

describe("buildWaMessage — isi pesan WhatsApp", () => {
  it("APP_URL kosong → hanya judul + isi (tanpa tautan)", () => {
    const msg = buildWaMessage({ title: "Pesanan baru #ABC", body: "Isi singkat.", link: "/orders/1" });
    expect(msg).toBe("Pesanan baru #ABC\n\nIsi singkat.");
  });

  it("APP_URL localhost TIDAK dilampirkan (jangan ekspos localhost)", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    const msg = buildWaMessage({ title: "T", body: "B", link: "/orders/1" });
    expect(msg).not.toContain("localhost");
    expect(msg).not.toContain("/orders/1");
  });

  it("APP_URL publik → tautan lengkap dilampirkan (slash akhir dibersihkan)", () => {
    vi.stubEnv("APP_URL", "https://tirta.example.com/");
    const msg = buildWaMessage({ title: "T", body: "B", link: "/orders/1" });
    expect(msg).toContain("https://tirta.example.com/orders/1");
  });

  it("tanpa link → tidak ada tautan; panjang dibatasi 4000 karakter", () => {
    expect(buildWaMessage({ title: "T", body: "B", link: null })).toBe("T\n\nB");
    const long = buildWaMessage({ title: "T", body: "x".repeat(5000), link: null });
    expect(long.length).toBeLessThanOrEqual(4000);
  });
});

describe("konstanta retry kanal WhatsApp", () => {
  it("percobaan WhatsApp dibatasi sama seperti email", () => {
    expect(WA_MAX_ATTEMPTS).toBe(3);
    expect(retryDelayMs(1)).toBe(30_000);
  });
});

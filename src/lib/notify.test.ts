/**
 * Unit test notifikasi — fungsi murni kebijakan pengiriman.
 * Fokus: TIDAK ada pengiriman ulang (Telegram) akibat retry email.
 */
import { describe, expect, it } from "vitest";
import {
  EMAIL_MAX_ATTEMPTS,
  emailAllowed,
  retryDelayMs,
  sanitizeEmailError,
  telegramSendOnce,
} from "./notify";

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

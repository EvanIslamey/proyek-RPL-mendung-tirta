import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SECRET_KEY_ENV,
  SecretStoreError,
  decryptSecret,
  encryptSecret,
  maskSecret,
} from "./secret-store";

/**
 * Test secret-store: enkripsi/dekripsi credential & masking.
 * - Roundtrip enkripsi harus mengembalikan plaintext asli.
 * - Ciphertext TIDAK boleh memuat plaintext (rahasia tidak bocor).
 * - Nilai rahasia tidak pernah dikirim utuh — hanya hint tersamarkan.
 * - Env kunci hilang → error jelas, bukan menyimpan plaintext.
 */

const KEY = "kunci-tes-sangat-rahasia-untuk-enkripsi-integrasi-123456";

const ORIGINAL_ENV = process.env[SECRET_KEY_ENV];

beforeEach(() => {
  process.env[SECRET_KEY_ENV] = KEY;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env[SECRET_KEY_ENV];
  else process.env[SECRET_KEY_ENV] = ORIGINAL_ENV;
});

describe("encryptSecret / decryptSecret — roundtrip & kerahasiaan", () => {
  it("roundtrip mengembalikan plaintext asli", () => {
    const secret = "nvapi-abcdefghijklmnop";
    const stored = encryptSecret(secret);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it("ciphertext TIDAK memuat plaintext (rahasia tidak bocor)", () => {
    const secret = "super-secret-token-xyz";
    const stored = encryptSecret(secret);
    expect(stored).not.toContain(secret);
    expect(stored.startsWith("v1:")).toBe(true);
  });

  it("enkripsi dua kali menghasilkan ciphertext berbeda (IV acak)", () => {
    const secret = "token-sama";
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("string kosong diteruskan apa adanya", () => {
    expect(encryptSecret("")).toBe("");
    expect(decryptSecret("")).toBe("");
  });

  it("env kunci hilang → SecretStoreError (bukan menyimpan plaintext)", () => {
    delete process.env[SECRET_KEY_ENV];
    expect(() => encryptSecret("rahasia")).toThrow(SecretStoreError);
  });

  it("format rusak / kunci salah → error saat dekripsi", () => {
    expect(() => decryptSecret("bukan-format-valid")).toThrow(SecretStoreError);
    // Kunci salah: set env berbeda lalu coba dekripsi.
    const stored = encryptSecret("rahasia");
    process.env[SECRET_KEY_ENV] = "kunci-sama-sekali-berbeda";
    expect(() => decryptSecret(stored)).toThrow(SecretStoreError);
  });
});

describe("maskSecret — nilai rahasia tidak pernah utuh", () => {
  it("panjang ≥ 8 → menampilkan 3 + dots + 4 terakhir", () => {
    expect(maskSecret("nvapi-abcdefgh1234")).toBe("nva••••••••1234");
  });

  it("nilai pendek (< 8) disamarkan penuh", () => {
    expect(maskSecret("abc")).toBe("••••••••");
    expect(maskSecret("1234567")).toBe("••••••••");
  });

  it("null/kosong → null", () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("")).toBeNull();
    expect(maskSecret("   ")).toBeNull();
  });

  it("hint tidak pernah memuat nilai penuh", () => {
    const secret = "nvapi-abcdefghijkl1234";
    const hint = maskSecret(secret)!;
    expect(hint).not.toBe(secret);
    expect(hint).not.toContain("efghijkl");
  });
});

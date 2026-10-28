/**
 * Penyimpanan credential terenkripsi untuk Pengaturan Integrasi
 * (WhatsApp & API Key AI).
 *
 * Prinsip keamanan:
 * - Credential disimpan di DB sebagai ciphertext AES-256-GCM, bukan plaintext.
 * - Kunci enkripsi diambil dari environment variable SECRET_ENCRYPTION_KEY
 *   (server-side ONLY — tidak pernah dikirim ke frontend).
 * - Nilai asli TIDAK PERNAH dikirim ke frontend; hanya `credentialHint`
 *   yang sudah disamarkan (mis. "sk-••••1234").
 * - Nilai asli TIDAK PERNAH dicatat ke log / pesan error.
 */

import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const VERSION = "v1";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // nonce GCM standar
const TAG_BYTES = 16;

/** Nama env var yang menyimpan kunci enkripsi (32 byte heksadesimal atau bebas). */
export const SECRET_KEY_ENV = "SECRET_ENCRYPTION_KEY";

export class SecretStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreError";
  }
}

/**
 * Ambil kunci enkripsi dari environment.
 * Memakai scrypt untuk memperoleh 32 byte dari nilai bebas (pendek/panjang).
 */
function getKey(): Buffer {
  const raw = process.env[SECRET_KEY_ENV]?.trim();
  if (!raw) {
    throw new SecretStoreError(
      `${SECRET_KEY_ENV} belum diatur di server. Tidak dapat menyimpan credential terenkripsi.`,
    );
  }
  // scrypt dengan salt tetap agar kunci stabil antar proses (key derivation).
  return crypto.scryptSync(raw, "mendung-tirta-secret-store", KEY_BYTES);
}

/**
 * Enkripsi nilai rahasia → "v1:<iv_b64>:<tag_b64>:<ct_b64>".
 * Melempar SecretStoreError bila env kunci belum diatur.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return "";
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/**
 * Dekripsi nilai tersimpan kembali ke plaintext asli.
 * Melempar SecretStoreError bila format/tetangga tidak valid atau env hilang.
 */
export function decryptSecret(stored: string): string {
  if (!stored) return "";
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SecretStoreError("Format credential tersimpan tidak valid.");
  }
  const key = getKey();
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretStoreError("Format credential tersimpan tidak valid.");
  }
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    // Autentikasi GCM gagal → kunci salah atau data rusak/dimanipulasi.
    throw new SecretStoreError("Credential tidak dapat didekripsi (kunci salah atau data rusak).");
  }
}

/**
 * Samarkan nilai rahasia untuk ditampilkan di UI: "sk-••••1234".
 * Nilai pendek (< 8 karakter) disamarkan penuh agar tidak membocorkan.
 */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length < 8) return "••••••••";
  const head = trimmed.slice(0, 3);
  const tail = trimmed.slice(-4);
  return `${head}${"•".repeat(8)}${tail}`;
}

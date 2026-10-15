/**
 * Pembangun pesan MIME (multipart/alternative text+html) untuk transport SMTP
 * dan file outbox (.eml). Semua baris pakai CRLF; header non-ASCII (subjek/
 * nama) dikodekan RFC 2047 (=?UTF-8?B?...?=) agar aman di server mana pun.
 */

import type { MailMessage } from "./types";

const CRLF = "\r\n";

/** Cegah header injection: nilai header tidak boleh mengandung CR/LF. */
export function assertSafeHeaderValue(name: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Nilai header ${name} mengandung karakter terlarang (CR/LF).`);
  }
}

/** Format alamat: "Nama <email>" dengan nama dikodekan bila non-ASCII. */
export function formatAddress(email: string, name?: string): string {
  assertSafeHeaderValue("alamat", email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Alamat email tidak valid.");
  }
  if (!name) return `<${email}>`;
  assertSafeHeaderValue("nama", name);
  const safeName = /[^\x20-\x7E]/.test(name) ? encodeWord(name) : `"${name.replace(/"/g, '\\"')}"`;
  return `${safeName} <${email}>`;
}

function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function encodeSubject(subject: string): string {
  assertSafeHeaderValue("subjek", subject);
  return /[^\x20-\x7E]/.test(subject) ? encodeWord(subject) : subject;
}

/** Base64 dengan wrap 76 karakter (sesuai RFC 2046). */
function base64Wrap(data: string): string {
  const b64 = Buffer.from(data, "utf8").toString("base64");
  return b64.replace(/(.{76})/g, "$1\r\n");
}

/** Bangun seluruh pesan MIME (headers + multipart text/html). */
export function buildMimeMessage(opts: {
  fromEmail: string;
  fromName?: string;
  message: MailMessage;
}): string {
  const { fromEmail, fromName, message } = opts;
  const boundary = `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const headers = [
    `From: ${formatAddress(fromEmail, fromName)}`,
    `To: ${formatAddress(message.to, message.toName)}`,
    `Subject: ${encodeSubject(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join(CRLF);

  const parts = [
    headers,
    CRLF,
    `--${boundary}${CRLF}`,
    "Content-Type: text/plain; charset=utf-8${CRLF}",
    "Content-Transfer-Encoding: base64${CRLF}",
    CRLF,
    base64Wrap(message.text),
    CRLF,
    `--${boundary}${CRLF}`,
    "Content-Type: text/html; charset=utf-8${CRLF}",
    "Content-Transfer-Encoding: base64${CRLF}",
    CRLF,
    base64Wrap(message.html),
    CRLF,
    `--${boundary}--${CRLF}`,
  ].join("");

  return parts;
}

/** Dot-stuffing untuk fase DATA SMTP (baris yang diawali "." digandakan). */
export function dotStuff(mime: string): string {
  return mime.replace(/^\./gm, "..");
}

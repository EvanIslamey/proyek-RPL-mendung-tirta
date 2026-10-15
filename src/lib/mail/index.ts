/**
 * Lapisan pengiriman email Mendung Tirta.
 *
 * Transport dipilih dari env (B4):
 *   MAIL_TRANSPORT=outbox | smtp | http   (default otomatis)
 *   - outbox : tulis berkas .eml ke mail-outbox/ — MODE UJI AMAN, default
 *              bila belum ada kredensial (tidak mengirim keluar).
 *   - smtp   : butuh MAIL_HOST (+ MAIL_PORT, MAIL_USERNAME/PASSWORD opsional)
 *   - http   : API transactional (mis. Resend) — butuh MAIL_API_URL + MAIL_API_KEY
 *
 * Kredensial HANYA dibaca backend, tidak pernah dikirim ke frontend/model AI.
 * Semua nilai header divalidasi anti header-injection (CR/LF).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { buildMimeMessage, assertSafeHeaderValue } from "./mime";
import { sendViaSmtp, smtpConfigFromEnv } from "./smtp";
import type { MailMessage, Mailer } from "./types";

export type { MailMessage, Mailer } from "./types";
export { renderEmail, escapeHtml, formatDateId } from "./render";

export function fromAddress(): { email: string; name: string } {
  return {
    email: process.env.MAIL_FROM_ADDRESS?.trim() || "no-reply@mendungtirta.local",
    name: process.env.MAIL_FROM_NAME?.trim() || "Mendung Tirta",
  };
}

/** Transport outbox: tulis .eml ke direktori (default mail-outbox/). */
const outboxMailer: Mailer = {
  name: "outbox",
  async send(message) {
    const dir = process.env.MAIL_OUTBOX_DIR?.trim() || "mail-outbox";
    const { email, name } = fromAddress();
    const mime = buildMimeMessage({ fromEmail: email, fromName: name, message });
    const safeTo = message.to.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
    const file = path.join(dir, `${Date.now()}-${safeTo}.eml`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, mime, "utf8");
  },
};

/** Transport HTTP API (gaya Resend: from/to/subject/text/html). */
const httpMailer: Mailer = {
  name: "http",
  async send(message) {
    const url = process.env.MAIL_API_URL?.trim();
    const key = process.env.MAIL_API_KEY?.trim();
    if (!url || !key) throw new Error("MAIL_API_URL / MAIL_API_KEY belum dikonfigurasi.");
    const { email, name } = fromAddress();

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from: `${name} <${email}>`,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`API email HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  },
};

const smtpMailer: Mailer = {
  name: "smtp",
  send(message) {
    const cfg = smtpConfigFromEnv();
    const { email, name } = fromAddress();
    return sendViaSmtp(cfg, email, name, message);
  },
};

/** Pilih transport dari env (auto: http > smtp > outbox bila tidak dispesifikasikan). */
export function getMailer(): Mailer {
  const explicit = process.env.MAIL_TRANSPORT?.trim().toLowerCase();
  if (explicit === "outbox" || explicit === "file") return outboxMailer;
  if (explicit === "smtp") return smtpMailer;
  if (explicit === "http") return httpMailer;
  if (explicit) throw new Error(`MAIL_TRANSPORT tidak dikenal: "${explicit}" (pakai outbox|smtp|http).`);

  if (process.env.MAIL_API_URL?.trim() && process.env.MAIL_API_KEY?.trim()) return httpMailer;
  if (process.env.MAIL_HOST?.trim()) return smtpMailer;
  return outboxMailer;
}

/**
 * Kirim email dengan validasi header. Melempar bila transport gagal —
 * pemanggil (notify.ts) yang menangani retry/status; tidak pernah merusak
 * transaksi bisnis.
 */
export async function sendMail(message: MailMessage): Promise<string> {
  assertSafeHeaderValue("to", message.to);
  assertSafeHeaderValue("subjek", message.subject);
  const mailer = getMailer();
  await mailer.send(message);
  return mailer.name;
}

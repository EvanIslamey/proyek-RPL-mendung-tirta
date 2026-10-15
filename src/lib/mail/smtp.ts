/**
 * Klien SMTP minimal tanpa dependensi ekstra (node:net + node:tls).
 *
 * Dukungan: greeting → EHLO → (opsional) STARTTLS → AUTH PLAIN/LOGIN →
 * MAIL FROM → RCPT TO → DATA (dot-stuffing, MIME base64) → QUIT.
 * Semua respons dibatasi timeout; error dilempar sebagai Error biasa TANPA
 * menyertakan kredensial (hanya kode & tahap).
 *
 * Diverifikasi lewat unit test terhadap server SMTP palsu lokal (lihat
 * src/lib/mail/smtp.test.ts) — kredensial eksternal tidak diperlukan untuk
 * pengujian protocol.
 */

import net from "node:net";
import tls from "node:tls";
import { buildMimeMessage, dotStuff, formatAddress } from "./mime";
import type { MailMessage } from "./types";

export type SmtpConfig = {
  host: string;
  port: number;
  /** true = TLS implisit (port 465); false = plaintext lalu STARTTLS bila tersedia. */
  secure: boolean;
  username?: string;
  password?: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT = 15_000;

class SmtpSession {
  private buffer = "";
  private waiters: { resolve: (lines: string[]) => void; reject: (e: Error) => void }[] = [];
  private ready: string[][] = []; // blok respons yang tiba sebelum ada penerima
  private pendingLines: string[] = [];
  private closed = false;
  private socket: net.Socket;
  private timeout?: NodeJS.Timeout;

  constructor(socket: net.Socket, private timeoutMs: number) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => this.fail(new Error("Koneksi SMTP terputus.")));
    this.touch();
  }

  private touch() {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(
      () => this.fail(new Error("Timeout menunggu respons server SMTP.")),
      this.timeoutMs,
    );
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let idx: number;
    // Respons = baris berakhir CRLF; baris final tanpa "-" adalah akhir blok.
    while ((idx = this.buffer.indexOf("\r\n")) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.pendingLines.push(line);
      const final = /^(\d{3})( |$)/.test(line); // "250 " atau "250" (tanpa "-")
      if (final) {
        const block = this.pendingLines;
        this.pendingLines = [];
        const w = this.waiters.shift();
        if (w) {
          this.touch();
          w.resolve(block);
        } else {
          this.ready.push(block); // simpan — penerima menyusul
        }
      }
    }
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    const pending = this.waiters.splice(0);
    for (const w of pending) w.reject(err);
    this.socket.destroy();
  }

  /** Tunggu blok respons berikutnya TANPA mengirim apa pun (aman dari race). */
  waitFor(allowed: number[]): Promise<string[]> {
    if (this.closed) return Promise.reject(new Error("Koneksi SMTP sudah tertutup."));
    const take = (block: string[]): Promise<string[]> => {
      const code = Number(block[0]?.slice(0, 3));
      if (!allowed.includes(code)) {
        return Promise.reject(
          new Error(`Server SMTP menolak perintah (kode ${code}).`),
        );
      }
      return Promise.resolve(block);
    };
    const queued = this.ready.shift();
    if (queued) return take(queued);
    this.touch();
    return new Promise((resolve, reject) => {
      this.waiters.push({
        resolve: (block) => take(block).then(resolve, reject),
        reject,
      });
    });
  }

  /** Kirim perintah, tunggu blok respons final. */
  command(cmd: string, allowed: number[]): Promise<string[]> {
    if (this.closed) return Promise.reject(new Error("Koneksi SMTP sudah tertutup."));
    const p = this.waitFor(allowed);
    this.write(cmd + "\r\n");
    return p;
  }

  /** Upgrade ke TLS (STARTTLS) — ganti socket, session tetap dipakai. */
  upgradeToTls(servername: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("error");
      plain.removeAllListeners("close");
      const secured = tls.connect({ socket: plain, servername }, () => {
        this.socket = secured;
        secured.setEncoding("utf8");
        secured.on("data", (c: string) => this.onData(c));
        secured.on("error", (e) => this.fail(e));
        secured.on("close", () => this.fail(new Error("Koneksi SMTP terputus.")));
        this.buffer = "";
        this.pendingLines = [];
        resolve();
      });
      secured.on("error", reject);
    });
  }

  write(data: string) {
    this.touch();
    this.socket.write(data);
  }

  end() {
    if (this.timeout) clearTimeout(this.timeout);
    this.closed = true;
    this.socket.end();
  }
}

function connectSocket(cfg: SmtpConfig): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s: net.Socket = cfg.secure
      ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : net.connect({ host: cfg.host, port: cfg.port });
    const onConnect = () => {
      s.off("error", onError);
      resolve(s);
    };
    const onError = (e: Error) => reject(e);
    s.once(cfg.secure ? "secureConnect" : "connect", onConnect);
    s.once("error", onError);
    setTimeout(() => reject(new Error("Timeout terhubung ke server SMTP.")), cfg.timeoutMs ?? DEFAULT_TIMEOUT).unref?.();
  });
}

/** Kirim satu email via SMTP. Melempar Error tanpa kredensial di pesan. */
export async function sendViaSmtp(cfg: SmtpConfig, fromEmail: string, fromName: string | undefined, message: MailMessage): Promise<void> {
  const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT;
  const socket = await connectSocket(cfg);
  const session = new SmtpSession(socket, timeout);

  try {
    await session.waitFor([220]); // greeting (tanpa kirim apa pun)
    let caps = await session.command("EHLO localhost", [250]);
    const capText = caps.join("\n").toUpperCase();

    // STARTTLS bila server mendukung & bukan TLS implisit.
    if (!cfg.secure && capText.includes("STARTTLS")) {
      await session.command("STARTTLS", [220]);
      await session.upgradeToTls(cfg.host);
      caps = await session.command("EHLO localhost", [250]);
    }

    // Autentikasi bila kredensial disediakan.
    if (cfg.username && cfg.password) {
      const authCaps = caps.join("\n").toUpperCase();
      if (authCaps.includes("AUTH PLAIN")) {
        const token = Buffer.from(`\0${cfg.username}\0${cfg.password}`, "utf8").toString("base64");
        await session.command(`AUTH PLAIN ${token}`, [235]);
      } else {
        await session.command("AUTH LOGIN", [334]);
        await session.command(Buffer.from(cfg.username, "utf8").toString("base64"), [334]);
        await session.command(Buffer.from(cfg.password, "utf8").toString("base64"), [235]);
      }
    }

    await session.command(`MAIL FROM:<${fromEmail}>`, [250]);
    await session.command(`RCPT TO:<${message.to}>`, [250, 251]);
    await session.command("DATA", [354]);

    const mime = dotStuff(buildMimeMessage({ fromEmail, fromName, message }));
    // Blok respons 250 diambil dulu, baru data ditulis — bebas race.
    const ok = session.waitFor([250]);
    session.write(mime + "\r\n.\r\n");
    await ok;

    await session.command("QUIT", [221]).catch(() => undefined);
  } finally {
    session.end();
  }
}

/** Validasi konfigurasi env → objek config (tanpa melempar kredensial). */
export function smtpConfigFromEnv(): SmtpConfig {
  const host = process.env.MAIL_HOST?.trim();
  if (!host) throw new Error("MAIL_HOST belum dikonfigurasi.");
  const port = Number(process.env.MAIL_PORT ?? "587") || 587;
  const secure =
    (process.env.MAIL_SECURE ?? "").toLowerCase() === "true" || port === 465;
  return {
    host,
    port,
    secure,
    username: process.env.MAIL_USERNAME?.trim() || undefined,
    password: process.env.MAIL_PASSWORD || undefined,
    timeoutMs: Number(process.env.MAIL_TIMEOUT_MS ?? "") || DEFAULT_TIMEOUT,
  };
}

/** Dipakai index.ts agar format alamat konsisten. */
export { formatAddress };

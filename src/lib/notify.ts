/**
 * Sistem notifikasi in-app + email + Telegram (Fitur B, C & Telegram).
 *
 * Alur & jaminan:
 * 1. `notifyInTx(tx, ...)` dipanggil DALAM transaksi bisnis → baris notifikasi
 *    ikut rollback bila transaksi gagal (tidak ada notifikasi/email/Telegram palsu).
 * 2. SETELAH commit, pemanggil memanggil `dispatchEmails(ids)` → email & Telegram
 *    dikirim di luar transaksi. Gagal email/Telegram TIDAK PERNAH membatalkan pesanan.
 * 3. Anti-duplikat ganda lapis:
 *    - unik (userId, dedupeKey) saat insert → event sama tak menduplikasi baris;
 *    - klaim atomik PENDING/FAILED → SENDING → hanya satu proses mengirim.
 * 4. Retry terbatas (EMAIL_MAX_ATTEMPTS) dengan backoff; jadwal retry disimpan
 *    di emailNextAt dan diambil lagi oleh `dispatchDueEmails()` (dipanggil
 *    otomatis via timer dalam proses, atau cron luar — lihat README).
 * 5. Email non-esensial (STOCK_LOW) menghormati preferensi `User.emailAlerts`;
 *    email transaksional (pesanan/pembayaran) selalu terkirim.
 * 6. Telegram menghormati `User.telegramNotify` dan `User.telegramChatId`,
 *    dan hanya dikirim pada percobaan pertama — retry email TIDAK mengirim
 *    ulang notifikasi Telegram yang sama (anti pengiriman ganda).
 * 7. Kegagalan final memicu notifikasi in-app ke admin (email SKIPPED —
 *    loop-guard, tanpa mengirim email lagi).
 */

import { prisma } from "./prisma";
import { sendMail, renderEmail } from "./mail";
import { sendTelegramNotification, sendTelegramToAdmins } from "./telegram";
import type { NotificationKind, Prisma } from "../../prisma/generated/client";

export type NotifyInput = {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string | null;
  dedupeKey: string;
  /** false = email NON-esensial → hormati preferensi user.emailAlerts */
  essential?: boolean;
};

export const EMAIL_MAX_ATTEMPTS = 3;

/** Backoff retry (ms) berdasarkan jumlah percobaan GAGAL berjalan. */
export function retryDelayMs(attemptsSoFar: number): number {
  return attemptsSoFar <= 1 ? 30_000 : 120_000;
}

/** Galat → pesan pendek aman: tanpa stack trace, tanpa rahasia. */
export function sanitizeEmailError(e: unknown): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return msg
    .replace(/(bearer\s+)[^\s"']+/gi, "$1***")
    .replace(/\b(api[_-]?key|password|token|secret)=?[^\s&"']+/gi, "$1=***")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** Kebijakan preferensi: transaksional (essential) tidak bisa dimatikan. */
export function emailAllowed(essential: boolean | undefined, emailAlerts: boolean): boolean {
  return (essential ?? true) || emailAlerts;
}

/**
 * Telegram hanya dikirim pada percobaan PERTAMA sebuah notifikasi.
 * Retry email (baris FAILED → diklaim ulang) tidak boleh mengirim ulang
 * notifikasi Telegram yang sama — anti pengiriman ganda akibat retry.
 * `attemptsBefore` = jumlah percobaan SEBELUM percobaan berjalan (dari klaim).
 */
export function telegramSendOnce(attemptsBefore: number): boolean {
  return attemptsBefore === 0;
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e &&
    (e as { code?: unknown }).code === "P2002"
  );
}

/**
 * Buat baris notifikasi DALAM transaksi `tx` (ikut rollback bila transaksi
 * gagal). Mengembalikan id notifikasi, atau null bila dedupe menekan duplikat.
 */
export async function notifyInTx(
  tx: Prisma.TransactionClient,
  input: NotifyInput,
): Promise<string | null> {
  const essential = input.essential ?? true;
  let emailStatus: "PENDING" | "SKIPPED" = "PENDING";

  if (!essential) {
    const u = await tx.user.findUnique({
      where: { id: input.userId },
      select: { emailAlerts: true },
    });
    if (!emailAllowed(false, u?.emailAlerts ?? true)) emailStatus = "SKIPPED";
  }

  try {
    const row = await tx.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        body: input.body.slice(0, 2000),
        link: input.link ?? null,
        dedupeKey: input.dedupeKey,
        emailStatus,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    if (isUniqueViolation(e)) return null; // event sama → sudah tercatat
    throw e;
  }
}

/** Alias: notifikasi di luar transaksi apa pun (mis. saat registrasi). */
export function notifyStandalone(input: NotifyInput): Promise<string | null> {
  return notifyInTx(prisma, input);
}

/* ------------------------------------------------------------------ */
/* Pengiriman email (setelah commit)                                   */
/* ------------------------------------------------------------------ */

function labelForLink(link: string): string {
  if (link.startsWith("/orders/")) return "Lihat Pesanan";
  if (link.startsWith("/seller")) return "Buka Dashboard Penjual";
  if (link.startsWith("/admin")) return "Buka Halaman Admin";
  if (link.startsWith("/products")) return "Lihat Produk";
  return "Lihat di Mendung Tirta";
}

type NotificationRow = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  emailAttempts: number;
  createdAt: Date;
  user: { id: string; name: string; email: string };
};

/** Klaim atomik satu baris untuk dikirim (mencegah pengiriman ganda). */
async function claim(id: string): Promise<NotificationRow | null> {
  const now = new Date();
  const claimed = await prisma.notification.updateMany({
    where: {
      id,
      emailStatus: { in: ["PENDING", "FAILED"] },
      emailAttempts: { lt: EMAIL_MAX_ATTEMPTS },
      OR: [{ emailNextAt: null }, { emailNextAt: { lte: now } }],
    },
    data: { emailStatus: "SENDING" },
  });
  if (claimed.count === 0) return null;
  return prisma.notification.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

/** Beri tahu admin (in-app + Telegram) bahwa email notifikasi gagal. */
async function alertAdminsEmailFailed(failed: NotificationRow, error: string): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });
  const masked = failed.user.email.replace(/^(.).*(@.*)$/, "$1***$2");
  for (const a of admins) {
    try {
      await prisma.notification.create({
        data: {
          userId: a.id,
          kind: "ACCOUNT_ALERT",
          title: "Pengiriman email notifikasi gagal",
          body:
            `Email notifikasi (${failed.kind}) ke ${masked} gagal setelah ${EMAIL_MAX_ATTEMPTS} percobaan. ` +
            `Detail: ${error}`,
          link: "/admin/dashboard",
          dedupeKey: `email-failed:${failed.id}`,
          emailStatus: "SKIPPED", // loop-guard: jangan kirim email tentang email gagal
        },
      });
    } catch (e) {
      if (!isUniqueViolation(e)) {
        console.error("[notify] gagal mencatat alert admin:", sanitizeEmailError(e));
      }
    }
  }

  // Kirim Telegram ke admin (non-blocking)
  await sendTelegramToAdmins(
    "⚠️ Email Notifikasi Gagal",
    `Email notifikasi (${failed.kind}) ke ${masked} gagal setelah ${EMAIL_MAX_ATTEMPTS} percobaan.\nDetail: ${error}`,
  ).catch(() => undefined);
}

/** Kirim satu baris (sudah diklaim) → perbarui status SENT/FAILED. */
async function sendOne(row: NotificationRow): Promise<void> {
  const { html, text } = renderEmail(row.user.name, {
    title: row.title,
    lines: row.body.split("\n"),
    link: row.link ? { href: row.link, label: labelForLink(row.link) } : null,
    timestamp: row.createdAt,
  });

  try {
    const transport = await sendMail({
      to: row.user.email,
      toName: row.user.name,
      subject: row.title,
      text,
      html,
    });
    await prisma.notification.update({
      where: { id: row.id },
      data: {
        emailStatus: "SENT",
        emailAttempts: row.emailAttempts + 1,
        emailError: null,
        emailNextAt: null,
      },
    });
    // Log aman: hanya metadata, tanpa isi pesan/kredensial.
    console.log(`[mail] SENT id=${row.id} kind=${row.kind} transport=${transport}`);
  } catch (e) {
    const attempts = row.emailAttempts + 1;
    const error = sanitizeEmailError(e);
    const final = attempts >= EMAIL_MAX_ATTEMPTS;
    await prisma.notification.update({
      where: { id: row.id },
      data: {
        emailStatus: "FAILED",
        emailAttempts: attempts,
        emailError: error,
        emailNextAt: final ? null : new Date(Date.now() + retryDelayMs(attempts)),
      },
    });
    console.error(`[mail] GAGAL id=${row.id} percobaan=${attempts}/${EMAIL_MAX_ATTEMPTS}: ${error}`);
    if (final) await alertAdminsEmailFailed(row, error);
  }
}

/**
 * Kirim email & Telegram untuk daftar notifikasi hasil commit. Tidak PERNAH melempar —
 * kegagalan dicatat per baris. Aman dipanggil `void dispatchEmails(ids)`.
 */
export async function dispatchEmails(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return;
  try {
    for (const id of unique) {
      const row = await claim(id);
      if (!row) continue;
      // Percobaan pertama (klaim: emailAttempts=0) → kirim Telegram sekali saja;
      // retry email berikutnya TIDAK mengirim ulang Telegram (anti duplikat).
      const firstAttempt = telegramSendOnce(row.emailAttempts);
      await sendOne(row);
      // Kirim Telegram secara terpisah (gagal tidak block email)
      if (firstAttempt) {
        await sendTelegramNotification(row.user.id, row.title, row.body, row.link ?? undefined).catch((e) => {
          console.error(`[telegram] GAGAL id=${row.id}:`, sanitizeEmailError(e));
        });
      }
    }
  } catch (e) {
    console.error("[notify] dispatch error:", sanitizeEmailError(e));
  } finally {
    scheduleRetry();
  }
}

/* ----------------------------- retry scheduler ---------------------------- */

let retryTimer: NodeJS.Timeout | null = null;

/** Ambil baris yang jatuh tempo untuk retry (cron luar bisa memanggil ini). */
export async function dispatchDueEmails(limit = 10): Promise<number> {
  const due = await prisma.notification.findMany({
    where: {
      emailStatus: { in: ["PENDING", "FAILED"] },
      emailAttempts: { lt: EMAIL_MAX_ATTEMPTS },
      OR: [{ emailNextAt: null }, { emailNextAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  if (due.length > 0) await dispatchEmails(due.map((d) => d.id));

  // Masih ada baris menunggu (mungkin berikutnya jatuh tempo belakangan)?
  // → jadwalkan timer berikutnya agar rantai retry tidak putus.
  const remaining = await prisma.notification.count({
    where: {
      emailStatus: { in: ["PENDING", "FAILED"] },
      emailAttempts: { lt: EMAIL_MAX_ATTEMPTS },
    },
  });
  if (remaining > 0) scheduleRetry();
  return due.length;
}

/** Jadwalkan retry in-process (timer di-unref agar tidak menahan proses). */
function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void dispatchDueEmails().catch(() => undefined);
  }, 60_000);
  retryTimer.unref?.();
}

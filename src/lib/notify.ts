/**
 * Sistem notifikasi in-app + email + Telegram + WhatsApp/Fonnte.
 *
 * Alur & jaminan:
 * 1. `notifyInTx(tx, ...)` dipanggil DALAM transaksi bisnis → baris notifikasi
 *    ikut rollback bila transaksi gagal (tidak ada notifikasi/email/Telegram/WA palsu).
 * 2. SETELAH commit, pemanggil memanggil `dispatchEmails(ids)` → email, Telegram
 *    DAN WhatsApp dikirim di luar transaksi. Gagal email/Telegram/WA TIDAK PERNAH
 *    membatalkan pesanan.
 * 3. Anti-duplikat ganda lapis:
 *    - unik (userId, dedupeKey) saat insert → event sama tak menduplikasi baris;
 *    - klaim atomik per-kanal (emailStatus / waStatus): PENDING/FAILED → SENDING
 *      → hanya satu proses mengirim; dua kanal tidak saling mengunci.
 * 4. Retry terbatas per kanal (EMAIL_MAX_ATTEMPTS / WA_MAX_ATTEMPTS) dengan
 *    backoff; jadwal disimpan di emailNextAt/waNextAt dan diambil lagi oleh
 *    `dispatchDueEmails()` / `dispatchDueWhatsApp()` (timer dalam proses).
 * 5. Email non-esensial (STOCK_LOW) menghormati preferensi `User.emailAlerts`;
 *    email transaksional (pesanan/pembayaran) selalu terkirim.
 * 6. Telegram menghormati `User.telegramNotify` dan `User.telegramChatId`,
 *    dan hanya dikirim pada percobaan pertama — retry email TIDAK mengirim
 *    ulang notifikasi Telegram yang sama (anti pengiriman ganda).
 * 7. Kegagalan final memicu notifikasi in-app ke admin (email SKIPPED —
 *    loop-guard, tanpa mengirim email lagi).
 * 8. WhatsApp (Fonnte) = kanal TERPISAH dengan state sendiri (waStatus):
 *    - kelayakan DIPUTUSKAN saat baris dibuat (`resolveWaEligibility`): konfigurasi
 *      global aktif + provider Fonnte + (nomor profil valid +62 DAN persetujuan
 *      `whatsappNotify`, ATAU baris admin dengan penerima operasional terkonfigurasi).
 *      Baris yang tidak memenuhi → SKIPPED permanen — TIDAK PERNAH dikirim
 *      belakangan (mencegah ledakan pesan retroaktif & pesan ganda).
 *    - penerima dicek ULANG saat kirim (persetujuan bisa dicabut di antaranya);
 *    - satu kejadian hanya diwakili SATU baris admin (findFirst dedupe) →
 *      satu pesan operasional, bukan satu per admin;
 *    - kegagalan Fonnte dicatat per baris (waAttempts/waError/waNextAt) dan
 *      TIDAK PERNAH melempar → transaksi marketplace aman.
 * 9. Token Fonnte diambil dari config global terenkripsi (secret-store) — TIDAK
 *    pernah masuk log/pesan error (lihat src/lib/fonnte.ts hideSecret/clip).
 */

import { prisma } from "./prisma";
import { sendMail, renderEmail } from "./mail";
import { sendTelegramNotification, sendTelegramToAdmins } from "./telegram";
import { decryptSecret } from "./secret-store";
import { fonnteSendText } from "./fonnte";
import type { NotificationKind, Prisma, Role } from "../../prisma/generated/client";

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
export const WA_MAX_ATTEMPTS = 3;

const FONNTE_DEFAULT_BASE = "https://api.fonnte.com";

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

// ---------------------------------------------------------------------------
// Validasi penerima WhatsApp (ringkas — sengaja TIDAK mengimpor integrations.ts
// agar tidak ada siklus impor notify → integrations → auth → notify)
// ---------------------------------------------------------------------------

/** Nomor WhatsApp profil pengguna: format internasional Indonesia +628… */
export function isIndonesiaMobile(value: string | null | undefined): boolean {
  return !!value && /^\+628[1-9]\d{7,11}$/.test(value);
}

/** E.164 generik (+812… dst.) untuk nomor penerima operasional. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/** "628…,+628…" (meta.opsTargets) → daftar tervalidasi; entri salah dilepas. */
export function parseOpsTargets(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => isE164(s));
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

/**
 * Gerbang kanal Telegram dari panel Pengaturan Telegram (service TELEGRAM,
 * scope global) — fungsi murni, mudah diuji tanpa DB:
 * - `null` (baris konfigurasi belum pernah ada / panel belum dibuka) →
 *   perilaku LAMA: notifikasi Telegram tetap dikirim via env;
 * - selain itu → ikuti `isActive` (tombol Aktifkan/Nonaktifkan di panel).
 * Toggle Telegram HANYA memengaruhi kanal Telegram — Fonnte/WA tidak tersentuh.
 */
export function telegramGateAllows(isActive: boolean | null | undefined): boolean {
  return isActive === null || isActive === undefined ? true : isActive;
}

/** Baca gerbang Telegram dari DB. DB error → jangan mematikan kanal lama. */
export async function isTelegramChannelEnabled(): Promise<boolean> {
  try {
    const row = await prisma.integrationConfig.findUnique({
      where: { service_scope: { service: "TELEGRAM", scope: "" } },
      select: { isActive: true },
    });
    return telegramGateAllows(row?.isActive ?? null);
  } catch {
    return true;
  }
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e &&
    (e as { code?: unknown }).code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Kelayakan channel WhatsApp (diputuskan SAAT baris dibuat)
// ---------------------------------------------------------------------------

type WaEligibility = { status: "PENDING" | "SKIPPED"; reason: string | null };

/**
 * Putuskan kelayakan channel WhatsApp saat notifikasi dibuat:
 * - konfigurasi global (scope "") harus ada, AKTIF, provider Fonnte, & punya token;
 * - penerima = nomor profil sendiri (wajib +62 DAN persetujuan whatsappNotify);
 * - baris ADMIN dengan penerima operasional (meta.opsTargets) → PENDING, tetapi
 *   hanya SATU baris admin per dedupeKey (findFirst) → satu pesan per kejadian;
 * - selain itu SKIPPED permanen: baris lama / belum ada persetujuan TIDAK PERNAH
 *   dikirim belakangan (anti ledakan retroaktif & anti ganda).
 * Semua kegagalan pemeriksaan ditekan menjadi SKIPPED agar transaksi utama aman.
 */
async function resolveWaEligibility(
  tx: Prisma.TransactionClient,
  userId: string,
  dedupeKey: string,
): Promise<WaEligibility> {
  try {
    const u = await tx.user.findUnique({
      where: { id: userId },
      select: { phone: true, whatsappNotify: true, role: true },
    });
    if (!u) return { status: "SKIPPED", reason: "Pengguna tidak ditemukan." };

    const cfg = await tx.integrationConfig.findUnique({
      where: { service_scope: { service: "WHATSAPP", scope: "" } },
      select: { isActive: true, credentialEnc: true, provider: true, meta: true },
    });
    if (!cfg || !cfg.isActive || !cfg.credentialEnc) {
      return { status: "SKIPPED", reason: "Konfigurasi WhatsApp global tidak aktif." };
    }
    if (cfg.provider !== "fonnte") {
      return {
        status: "SKIPPED",
        reason: "Provider WhatsApp bukan Fonnte — integrasi lama tidak digunakan untuk pengiriman.",
      };
    }

    let meta: Record<string, string> | null = null;
    try {
      meta = cfg.meta ? (JSON.parse(cfg.meta) as Record<string, string>) : null;
    } catch {
      meta = null;
    }
    const ops = parseOpsTargets(meta?.opsTargets);

    if (u.role === "ADMIN" && ops.length > 0) {
      // Anti ganda: kejadian sama hanya diwakili SATU baris admin.
      const existing = await tx.notification.findFirst({
        where: {
          dedupeKey,
          NOT: { userId },
          waStatus: { in: ["PENDING", "SENDING", "SENT"] },
        },
        select: { id: true },
      });
      if (existing) {
        return {
          status: "SKIPPED",
          reason: "Kejadian ini sudah diwakili pesan WhatsApp operasional lain (anti ganda).",
        };
      }
      return { status: "PENDING", reason: null };
    }

    if (isIndonesiaMobile(u.phone) && u.whatsappNotify) return { status: "PENDING", reason: null };
    return {
      status: "SKIPPED",
      reason: isIndonesiaMobile(u.phone)
        ? "Persetujuan notifikasi WhatsApp belum diberikan pengguna."
        : "Nomor WhatsApp profil belum diisi atau belum format +62.",
    };
  } catch {
    return { status: "SKIPPED", reason: "Gagal memeriksa konfigurasi WhatsApp." };
  }
}

/**
 * Buat baris notifikasi DALAM transaksi `tx` (ikut rollback bila transaksi
 * gagal). Mengembalikan id notifikasi, atau null bila dedupe menekan duplikat.
 * Status kanal email & WhatsApp ditentukan di sini (lihat doc tingkat modul).
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

  const wa = await resolveWaEligibility(tx, input.userId, input.dedupeKey);

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
        waStatus: wa.status,
        waError: wa.reason, // riwayat: alasan SKIPPED / (nanti) galat pengiriman
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

  // Kirim Telegram ke admin (non-blocking) — dihormati gerbang panel Pengaturan
  // Telegram; gagal Telegram TIDAK PERNAH menggagalkan apapun.
  if (await isTelegramChannelEnabled()) {
    await sendTelegramToAdmins(
      "⚠️ Email Notifikasi Gagal",
      `Email notifikasi (${failed.kind}) ke ${masked} gagal setelah ${EMAIL_MAX_ATTEMPTS} percobaan.\nDetail: ${error}`,
    ).catch(() => undefined);
  }
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
 * Kirim email & Telegram (kanal email) + WhatsApp (kanal terpisah) untuk daftar
 * notifikasi hasil commit. Tidak PERNAH melempar — kegagalan dicatat per baris.
 * Aman dipanggil `void dispatchEmails(ids)`.
 */
export async function dispatchEmails(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return;
  // Kanal WhatsApp berjalan berdampingan (klaim waStatus sendiri — tidak saling
  // mengunci dengan email) dan ikut diselesaikan agar pemanggil yang menunggu
  // (uji/e2e) melihat hasil kedua kanal.
  const waDone = dispatchWhatsApp(unique);
  // Gerbang panel Pengaturan Telegram dibaca sekali per dispatch; tanpa baris
  // konfigurasi → perilaku lama (kirim via env). Fonnte tidak terpengaruh.
  const telegramOn = await isTelegramChannelEnabled();
  try {
    for (const id of unique) {
      const row = await claim(id);
      if (!row) continue;
      // Percobaan pertama (klaim: emailAttempts=0) → kirim Telegram sekali saja;
      // retry email berikutnya TIDAK mengirim ulang Telegram (anti duplikat).
      const firstAttempt = telegramSendOnce(row.emailAttempts);
      await sendOne(row);
      // Kirim Telegram secara terpisah (gagal tidak block email)
      if (firstAttempt && telegramOn) {
        await sendTelegramNotification(row.user.id, row.title, row.body, row.link ?? undefined).catch((e) => {
          console.error(`[telegram] GAGAL id=${row.id}:`, sanitizeEmailError(e));
        });
      }
    }
  } catch (e) {
    console.error("[notify] dispatch error:", sanitizeEmailError(e));
  } finally {
    await waDone; // tidak melempar — hanya menunggu selesai
    scheduleRetry();
  }
}

/* ------------------------------------------------------------------ */
/* Pengiriman WhatsApp via Fonnte (setelah commit, kanal terpisah)     */
/* ------------------------------------------------------------------ */

type WaRow = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  waAttempts: number;
  createdAt: Date;
  user: { id: string; name: string; phone: string | null; whatsappNotify: boolean; role: Role };
};

/** Klaim atomik satu baris untuk kanal WhatsApp (mencegah pengiriman ganda). */
async function claimWa(id: string): Promise<WaRow | null> {
  const now = new Date();
  const claimed = await prisma.notification.updateMany({
    where: {
      id,
      waStatus: { in: ["PENDING", "FAILED"] },
      waAttempts: { lt: WA_MAX_ATTEMPTS },
      OR: [{ waNextAt: null }, { waNextAt: { lte: now } }],
    },
    data: { waStatus: "SENDING" },
  });
  if (claimed.count === 0) return null;
  return prisma.notification.findUnique({
    where: { id },
    select: {
      id: true,
      kind: true,
      title: true,
      body: true,
      link: true,
      waAttempts: true,
      createdAt: true,
      user: { select: { id: true, name: true, phone: true, whatsappNotify: true, role: true } },
    },
  });
}

type WaRuntime = { token: string; baseUrl: string; ops: string[] };

/**
 * Muat runtime WhatsApp dari config global (token terenkripsi). Null bila tidak
 * aktif / provider bukan Fonnte / token tak terbaca → semua kasus itu berakhir
 * SKIPPED saat kirim (pesan basi TIDAK dikirim walau config aktif belakangan).
 */
async function loadWaRuntime(): Promise<WaRuntime | null> {
  try {
    const cfg = await prisma.integrationConfig.findUnique({
      where: { service_scope: { service: "WHATSAPP", scope: "" } },
    });
    if (!cfg || !cfg.isActive || !cfg.credentialEnc || cfg.provider !== "fonnte") return null;
    const token = decryptSecret(cfg.credentialEnc);
    if (!token) return null;
    let meta: Record<string, string> | null = null;
    try {
      meta = cfg.meta ? (JSON.parse(cfg.meta) as Record<string, string>) : null;
    } catch {
      meta = null;
    }
    return {
      token,
      baseUrl: (cfg.endpoint?.trim() || FONNTE_DEFAULT_BASE).replace(/\/+$/, ""),
      ops: parseOpsTargets(meta?.opsTargets),
    };
  } catch {
    return null;
  }
}

type WaTarget =
  | { action: "send"; runtime: WaRuntime; numbers: string[] }
  | { action: "skip"; reason: string };

/**
 * Tentukan penerima SAAT KIRIM: nomor profil dicek ulang (persetujuan bisa
 * dicabut sejak baris dibuat); baris ADMIN dengan penerima operasional memakai
 * nomor ops (satu pesan per kejadian — aturan anti ganda ada di pembuatan baris).
 */
async function resolveWaTargets(row: WaRow): Promise<WaTarget> {
  const runtime = await loadWaRuntime();
  if (!runtime) {
    return {
      action: "skip",
      reason: "Konfigurasi WhatsApp global tidak aktif / token tak terbaca / provider bukan Fonnte.",
    };
  }
  if (row.user.role === "ADMIN" && runtime.ops.length > 0) {
    return { action: "send", runtime, numbers: runtime.ops };
  }
  if (row.user.whatsappNotify && isIndonesiaMobile(row.user.phone)) {
    return { action: "send", runtime, numbers: [row.user.phone as string] };
  }
  return { action: "skip", reason: "Nomor WhatsApp tidak tersedia atau persetujuan dicabut." };
}

/**
 * Susun isi pesan WhatsApp: judul + isi + tautan.
 * Tautan hanya dilekatkan bila APP_URL publik (http/https) — URL localhost
 * TIDAK dikirim (tak berguna bagi penerima & jangan ekspos localhost).
 */
export function buildWaMessage(row: { title: string; body: string; link: string | null }): string {
  let msg = `${row.title}\n\n${row.body}`;
  const base = (process.env.APP_URL ?? "").replace(/\/+$/, "");
  if (
    row.link &&
    /^https?:\/\//i.test(base) &&
    !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(base)
  ) {
    msg += `\n\n${base}${row.link}`;
  }
  return msg.slice(0, 4000);
}

/** Samarkan nomor untuk log: 6281234567890 → 62812***7890. */
export function maskPhone(number: string): string {
  const d = number.replace(/\D/g, "");
  if (d.length <= 6) return "•••";
  return `${d.slice(0, 5)}***${d.slice(-4)}`;
}

/**
 * Kirim satu baris (sudah diklaim) → perbarui SENT/FAILED/SKIPPED + riwayat
 * (waAttempts/waError/waNextAt). Tidak PERNAH melempar.
 */
async function sendWaOne(row: WaRow): Promise<void> {
  try {
    const target = await resolveWaTargets(row);
    if (target.action === "skip") {
      await prisma.notification.update({
        where: { id: row.id },
        data: { waStatus: "SKIPPED", waError: target.reason, waNextAt: null },
      });
      console.log(`[wa] SKIP id=${row.id} kind=${row.kind}: ${target.reason}`);
      return;
    }

    const r = await fonnteSendText({
      baseUrl: target.runtime.baseUrl,
      token: target.runtime.token,
      targets: target.numbers,
      message: buildWaMessage(row),
    });

    if (r.ok) {
      await prisma.notification.update({
        where: { id: row.id },
        data: { waStatus: "SENT", waAttempts: row.waAttempts + 1, waError: null, waNextAt: null },
      });
      const shown = target.numbers.map(maskPhone).join(",");
      console.log(`[wa] SENT id=${row.id} kind=${row.kind} →${shown} (${target.numbers.length} tujuan)`);
      return;
    }

    const attempts = row.waAttempts + 1;
    const error = sanitizeEmailError(r.note); // note klien Fonnte sudah menyaring token
    const final = attempts >= WA_MAX_ATTEMPTS;
    await prisma.notification.update({
      where: { id: row.id },
      data: {
        waStatus: "FAILED",
        waAttempts: attempts,
        waError: error,
        waNextAt: final ? null : new Date(Date.now() + retryDelayMs(attempts)),
      },
    });
    console.error(`[wa] GAGAL id=${row.id} percobaan=${attempts}/${WA_MAX_ATTEMPTS}: ${error}`);
  } catch (e) {
    // Galat tak terduga → catat & selesai; TIDAK PERNAH dilempar ke pemanggil
    // (kegagalan WhatsApp tidak boleh merusak transaksi marketplace).
    const error = sanitizeEmailError(e);
    const attempts = row.waAttempts + 1;
    const final = attempts >= WA_MAX_ATTEMPTS;
    try {
      await prisma.notification.update({
        where: { id: row.id },
        data: {
          waStatus: "FAILED",
          waAttempts: attempts,
          waError: error,
          waNextAt: final ? null : new Date(Date.now() + retryDelayMs(attempts)),
        },
      });
    } catch {
      /* DB ikut gagal → baris dibiarkan; retry berikutnya mencoba klaim ulang */
    }
    console.error(`[wa] GAGAL id=${row.id}: ${error}`);
  }
}

/**
 * Kirim WhatsApp untuk daftar notifikasi hasil commit. Kanal TERPISAH dari
 * email (klaim waStatus sendiri — tidak saling mengunci). Tidak PERNAH melempar:
 * kegagalan dicatat per baris sehingga transaksi marketplace tidak terpengaruh.
 */
export async function dispatchWhatsApp(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return;
  try {
    for (const id of unique) {
      const row = await claimWa(id);
      if (!row) continue;
      await sendWaOne(row);
    }
  } catch (e) {
    console.error("[wa] dispatch error:", sanitizeEmailError(e));
  } finally {
    scheduleRetry();
  }
}

/** Ambil baris WhatsApp yang jatuh tempo untuk retry (cron luar bisa memanggil ini). */
export async function dispatchDueWhatsApp(limit = 10): Promise<number> {
  const due = await prisma.notification.findMany({
    where: {
      waStatus: { in: ["PENDING", "FAILED"] },
      waAttempts: { lt: WA_MAX_ATTEMPTS },
      OR: [{ waNextAt: null }, { waNextAt: { lte: new Date() } }],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  if (due.length > 0) await dispatchWhatsApp(due.map((d) => d.id));

  const remaining = await prisma.notification.count({
    where: { waStatus: { in: ["PENDING", "FAILED"] }, waAttempts: { lt: WA_MAX_ATTEMPTS } },
  });
  if (remaining > 0) scheduleRetry();
  return due.length;
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

/** Jadwalkan retry in-process (timer di-unref agar tidak menahan proses).
 * Timer yang sama mengambil email JATUH TEMPO dan WhatsApp JATUH TEMPO. */
function scheduleRetry(): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void Promise.allSettled([dispatchDueEmails(), dispatchDueWhatsApp()]);
  }, 60_000);
  retryTimer.unref?.();
}

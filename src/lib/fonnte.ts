/**
 * Klien Fonnte WhatsApp Gateway — dijalankan di BACKEND (bukan dari browser).
 *
 * API resmi Fonnte (dokumentasi docs.fonnte.com, okt 2026):
 * - POST {base}/device → profil & status perangkat terhubung
 *     response sukses: { device, device_status: "connect"|"disconnect", name, quota,
 *                        package, expired, status: true }
 *     response gagal  : { status: false, reason: "token invalid", ... }
 * - POST {base}/send   → kirim pesan teks; body FormData: target, message, countryCode
 *     response sukses: { status: true, detail: "success! message in queue", ... }
 *     response gagal  : { status/Status: false, reason/message, ... }  ← casing tidak konsisten!
 * Keduanya memakai header `Authorization: <TOKEN>` dengan TOKEN MENTAH —
 * TANPA prefix "Bearer" (lihat halaman API resmi Fonnte).
 * Token = token perangkat dari menu Device dashboard Fonnte.
 *
 * JAMINAN:
 * - Sukses HANYA bila body JSON provider menyatakan status true. Status HTTP 2xx
 *   saja TIDAK dianggap berhasil (Fonnte bisa membalas 2xx berisi status false).
 * - Field status kadang ditulis "Status" (huruf besar) pada response gagal →
 *   keduanya dibaca agar kegagalan tidak lolos sebagai sukses.
 * - Token TIDAK PERNAH dicetak, dimasukkan pesan error, atau selain header tujuan.
 * - Semua fungsi tidak PERNAH melempar: galat jaringan → hasil { ok: false } jujur.
 */

export type FonnteResult<T = undefined> = {
  ok: boolean;
  note: string;
  data?: T;
};

export type FonnteDevice = {
  number: string; // nomor WhatsApp perangkat (pengirim)
  name: string | null;
  status: string; // "connect" | "disconnect" | lainnya
  quota: string | null;
  package: string | null;
  expired: string | null;
};

/** Base URL resmi Fonnte. */
export const FONNTE_DEFAULT_BASE = "https://api.fonnte.com";

const DEFAULT_TIMEOUT_DEVICE_MS = 10_000;
const DEFAULT_TIMEOUT_SEND_MS = 20_000;

/** Potong teks provider agar note tetap wajar (alasan resmi Fonnte sangat pendek). */
function clip(value: unknown, max = 160): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  const clean = s
    .replace(/\s+/g, " ")
    .trim()
    // Run alfanumerik sangat panjang (≥20) dianggap rahasia → disamarkan;
    // nomor telepon (≤15 digit) & kata biasa tetap utuh agar note terbaca.
    .replace(/[A-Za-z0-9_.-]+/g, (run) =>
      run.replace(/[^A-Za-z0-9]/g, "").length >= 20 ? "•••" : run,
    );
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** Sembunyikan token dari teks apa pun (galat jaringan/proxy bisa mengecho header Authorization). */
function hideSecret(text: string, secret: string): string {
  const s = secret.trim();
  return s ? text.split(s).join("•••") : text;
}

/**
 * Nomor → format target Fonnte: digit internasional TANPA "+".
 * "+62812 3456-7890" → "6281234567890". Dipasangkan dengan countryCode "0"
 * (tanpa penggantian/prefix otomatis), sesuai contoh dokumentasi Fonnte.
 */
export function fonnteTarget(number: string): string {
  return number.replace(/\D/g, ""); // sisakan digit saja (input sudah divalidasi E.164 di hulu)
}

/**
 * Baca field status dari body Fonnte. Mendukung "status" (huruf kecil, docs umum)
 * dan "Status" (huruf besar, dipakai response gagal tertentu) + boolean/string.
 */
export function readFonnteStatus(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  for (const key of ["status", "Status"] as const) {
    const v = p[key];
    if (v === true) return true;
    if (v === false) return false;
    if (typeof v === "string") {
      const low = v.trim().toLowerCase();
      if (low === "true") return true;
      if (low === "false") return false;
    }
  }
  return null;
}

/** Ambil alasan kegagalan dari body (field yang dipakai dokumentasi Fonnte). */
function readFonnteReason(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  for (const key of ["reason", "message", "detail", "error"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return clip(v);
  }
  return "";
}

function normalizeBase(baseUrl?: string): string {
  const base = (baseUrl ?? "").trim() || FONNTE_DEFAULT_BASE;
  return base.replace(/\/+$/, "");
}

/** Fetch POST JSON/FormData dengan timeout → { raw?, status?, error? } tanpa melempar. */
async function postWithTimeout(
  url: string,
  token: string,
  body: FormData,
  timeoutMs: number,
): Promise<{ status: number; text: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: token }, // token mentah, TANPA Bearer (docs Fonnte)
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text().catch(() => null);
    return { status: res.status, text, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Token tidak pernah ada di URL (hanya header) — tetap disaring bila proxy mengecho header.
    const safe = hideSecret(clip(msg, 120), token);
    return {
      status: 0,
      text: null,
      error: /abort/i.test(msg) ? `timeout ${timeoutMs}ms` : safe,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** POST {base}/device — status koneksi perangkat Fonnte (bukan "sukses" dari HTTP saja). */
export async function fonnteDeviceProfile(opts: {
  baseUrl?: string;
  token: string;
  timeoutMs?: number;
}): Promise<FonnteResult<FonnteDevice>> {
  const token = opts.token.trim();
  if (!token) return { ok: false, note: "API token Fonnte belum diisi." };

  const url = `${normalizeBase(opts.baseUrl)}/device`;
  const form = new FormData();
  const { status: http, text, error } = await postWithTimeout(
    url,
    token,
    form,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_DEVICE_MS,
  );
  if (error) return { ok: false, note: `Gagal menghubungi Fonnte (${error}).` };

  const payload = parseJson(text);
  if (payload === null) {
    return { ok: false, note: `Response Fonnte tidak terbaca (HTTP ${http}).` };
  }
  const ok = readFonnteStatus(payload);
  if (ok !== true) {
    const reason = hideSecret(readFonnteReason(payload) || `HTTP ${http}`, token);
    return { ok: false, note: `Fonnte menolak koneksi: ${reason}.` };
  }

  const p = payload as Record<string, unknown>;
  const deviceNumber = typeof p.device === "string" ? p.device.trim() : "";
  const deviceStatus =
    typeof p.device_status === "string" ? p.device_status.trim().toLowerCase() : "";
  if (!deviceNumber) {
    return { ok: false, note: "Response Fonnte tidak memuat nomor perangkat." };
  }

  const device: FonnteDevice = {
    number: deviceNumber,
    name: typeof p.name === "string" && p.name.trim() ? clip(p.name, 60) : null,
    status: deviceStatus || "unknown",
    quota: typeof p.quota === "string" ? clip(p.quota, 40) : null,
    package: typeof p.package === "string" ? clip(p.package, 40) : null,
    expired: typeof p.expired === "string" ? clip(p.expired, 60) : null,
  };

  if (device.status !== "connect") {
    return {
      ok: false,
      note: `Perangkat Fonnte ${deviceNumber} terdaftar tetapi status "${device.status}" — buka menu Device di dashboard Fonnte lalu hubungkan/scan ulang QR-nya.`,
      data: device,
    };
  }

  const parts = [`Perangkat Fonnte terhubung: ${deviceNumber}`];
  if (device.name) parts.push(`nama "${device.name}"`);
  if (device.quota) parts.push(`sisa kuota ${device.quota}`);
  if (device.package) parts.push(`paket ${device.package}`);
  if (device.expired) parts.push(`berlaku s/d ${device.expired}`);
  return { ok: true, note: `${parts.join(", ")}.`, data: device };
}

/** POST {base}/send — kirim pesan teks; sukses hanya bila status true dari Fonnte. */
export async function fonnteSendText(opts: {
  baseUrl?: string;
  token: string;
  /** Satu atau beberapa nomor internasional (digit tanpa "+"); beberapa = dipisah koma (satu request). */
  targets: string[];
  message: string;
  timeoutMs?: number;
}): Promise<FonnteResult> {
  const token = opts.token.trim();
  if (!token) return { ok: false, note: "API token Fonnte belum diisi." };

  const numbers = opts.targets.map(fonnteTarget).filter(Boolean);
  if (numbers.length === 0) return { ok: false, note: "Nomor tujuan pesan kosong." };
  const message = opts.message.replace(/\u0000/g, "").trim();
  if (!message) return { ok: false, note: "Isi pesan kosong." };

  const url = `${normalizeBase(opts.baseUrl)}/send`;
  const form = new FormData();
  form.append("target", numbers.join(","));
  form.append("message", message);
  form.append("countryCode", "0"); // 0 = pakai nomor apa adanya (sudah internasional)
  form.append("preview", "false"); // jangan fetch link (hemat & jaga privasi URL lokal)
  form.append("delay", "0");
  form.append("typing", "false");

  const { status: http, text, error } = await postWithTimeout(
    url,
    token,
    form,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_SEND_MS,
  );
  if (error) return { ok: false, note: `Gagal menghubungi Fonnte (${error}).` };

  const payload = parseJson(text);
  if (payload === null) {
    return { ok: false, note: `Response Fonnte tidak terbaca (HTTP ${http}).` };
  }
  const ok = readFonnteStatus(payload);
  if (ok !== true) {
    const reason = hideSecret(readFonnteReason(payload) || `HTTP ${http}`, token);
    return { ok: false, note: `Fonnte menolak pesan: ${reason}.` };
  }

  const detail = hideSecret(readFonnteReason(payload) || "diterima", token);
  const dest = numbers.length > 1 ? `${numbers.length} tujuan` : numbers[0];
  return { ok: true, note: `Pesan terkirim ke ${dest} (antrean Fonnte: ${detail}).` };
}

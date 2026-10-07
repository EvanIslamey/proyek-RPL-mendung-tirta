/**
 * Rate limiter sederhana berbasis memori proses.
 *
 * KETERBATASAN (terdokumentasi): state disimpan di memori, sehingga berlaku
 * per instance proses. Untuk deployment multi-instance gunakan penyimpanan
 * bersama (Redis dkk.) — lihat README bagian Catatan Keamanan.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/** Bersihkan bucket yang sudah kedaluwarsa (dipanggil saat akses). */
function prune(now: number): void {
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * Catat satu percobaan untuk `key`. Melempar `ok:false` bila melebihi
 * `limit` percobaan dalam `windowMs` terakhir.
 */
export function hitRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  prune(now);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

/** Ambil client IP dari header (di belakang proxy) dengan fallback aman. */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "local";
}

/** Reset semua bucket — hanya untuk pengujian. */
export function resetRateLimits(): void {
  buckets.clear();
}

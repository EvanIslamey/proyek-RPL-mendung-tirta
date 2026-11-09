/**
 * Cache in-memory jangka pendek untuk data chatbot yang relatif stabil
 * (katalog, hitungan, statistik agregat, profil toko, info layanan).
 *
 * - TTL default 30 detik: data paling lambat "setengah menit" tertinggal.
 * - Invalidasi EKSPLISIT dipanggil dari route/lib mutasi (produk, pesanan,
 *   ulasan, toko, kategori, peran user) agar perubahan langsung terlihat.
 * - Otomatis DINONAKTIFKAN saat unit test (VITEST) — mock DB selalu segar.
 *
 * Hasil cache dianggap READ-ONLY — jangan dimutasi in-place oleh pemanggil.
 * (Keputusan: query chatbot berjalan ratusan ms; pertanyaan berulang dalam
 * satu sesi jadi instan tanpa mengambil seluruh database.)
 */

const DEFAULT_TTL_MS = 30_000;
const MAX_ENTRIES = 500;

type Entry = { value: unknown; expiresAt: number };

const store = new Map<string, Entry>();

function cacheEnabled(): boolean {
  return !process.env.VITEST;
}

/** Ambil nilai dari cache, atau hitung via `load` lalu simpan dengan TTL. */
export async function cached<T>(
  key: string,
  load: () => Promise<T>,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<T> {
  if (!cacheEnabled()) return load();

  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const value = await load();

  if (store.size >= MAX_ENTRIES) {
    for (const [k, e] of store) {
      if (e.expiresAt <= now) store.delete(k);
    }
    // Masih penuh → buang semuanya (lebih baik re-query daripada bocor memori).
    if (store.size >= MAX_ENTRIES) store.clear();
  }
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

/**
 * Buang SEMUA data cache chatbot. Dipanggil setelah setiap mutasi yang
 * memengaruhi jawaban chatbot (produk/pesanan/ulasan/toko/kategori/peran).
 * Cache sengaja dibuang total (bukan per-prefix) supaya tidak ada pasangan
 * key yang terlewat → tidak pernah menyajikan data basi setelah edit.
 */
export function invalidateAiCache(): void {
  store.clear();
}

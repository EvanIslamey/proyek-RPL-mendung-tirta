# Upgrade Chatbot: Filter Subjek Produk + Harga Digabung (AND)

Tanggal: 28 Okt 2026 · Komitmen: menyusul (lihat `git log`)

## Ringkasan

Chatbot Mendung Tirta kini mengekstrak **subjek/jenis produk** ("hasil laut",
"ikan", "umpan", "alat pancing", "cumi", dst.) dari pesan bahasa alami,
memvalidasinya ke **data aplikasi aktual** (tabel `Category` + nama produk),
lalu menggabungkannya dengan filter harga/stok/toko sebagai **kondisi AND di
level database** — tanpa merusak fitur filter harga lama.

## Cara subjek dikenali

1. **Ekstraksi frasa** (`extractSubjectPhrase`, murni): frasa harga/range,
   toko, sorting, rating, dan ketersediaan dibuang lebih dulu; sisa kata
   bermakna = frasa subjek.
   - "Produk hasil laut di bawah 50000" → `hasil laut`
   - "Ikan yang masih tersedia di bawah 100000" → `ikan`
   - "Hasil laut dari toko Hasil Laut Pak Budi di atas 50000" → `hasil laut`
   - "di bawah 50000" → tanpa subjek
2. **Validasi ke database** (`resolveProductSubject` → tabel `Category`,
   cache 60 detik):
   - frasa cocok kategori (exact > parsial dua arah) → **mode category**
     (`c.name ILIKE`)
   - >1 kandidat → **ambiguous** → jawaban menanyakan pilihan (jangan menebak)
   - tidak ada kategori → **mode name**: filter ketat pada `p.name` (AND) —
     produk yang hanya menyebut kata di *deskripsi* TIDAK ikut
     ("ikan" tidak menarik Umpan Minnow yang hanya menyebut "ikan" di deskripsi).
3. **Sinonim aman** (`SUBJECT_SYNONYMS`) dipetakan ke entitas yang benar-benar
   ada: `seafood/hasil pantai`→Hasil Laut, `pancing/fishing`→Alat Pancing,
   `lure/pelet/umpan ikan`→Umpan, `cumi-cumi/sotong`→"cumi", `ikan segar`→"ikan".

## Cara filter digabung

- `ProductFilter` kini memuat `subject` (fase): `{ phrase, mode, value }`.
- `filterConds()` = helper bersama **parameterized** (`Prisma.sql` binding)
  untuk `searchCatalog`, `findFocusProducts`, dan `countCatalog` — semua
  kondisi (harga, kategori, toko, rating, subjek) digabung **AND**,
  filter diterapkan **sebelum** `ORDER BY`/`LIMIT`.
- Kata kunci pencarian dibersihkan dari kata subjek — subjek dipakai sebagai
  kondisi AND ketat, bukan OR keyword.
- **Perbaikan bug latent**: klausa visibilitas `(status AVAILABLE/stock)` yang
  tadinya tanpa kurung bisa meloloskan baris di luar filter saat digabung
  `A OR B AND C` (precedence OR > AND). Kini dikurung dan di-AND-kan.
- Hasil selalu tervalidasi ulang di `fallbackResult.applyFilters` (safety net
  subjek/harga/kategori/toko/rating) sebelum dikirim ke frontend.

## Jawaban: deterministik untuk query berfilter

`generateReply` menjawab query dengan filter aktif (subjek/harga/kategori/
toko/stok/rating) lewat komposer fallback — **tanpa memanggil provider LLM**:

- daftar produk terfilter (nama — harga — stok — status — toko) +
  "Menampilkan X produk yang cocok" + tautan `/products?…` berfilter;
- hasil kosong → "Tidak ada produk {subjek} yang memenuhi filter …" (bukan
  "katalog kosong");
- ringkasan katalog/statistik TIDAK dicampur ke jawaban berfilter
  (`buildChatContext` melewati `fetchCatalogSummary` saat filter aktif);
- pertanyaan hitungan berfilter ("berapa jumlah produk hasil laut?") →
  `countCatalog` (COUNT dengan filter yang sama) → hanya angka;
- DB gagal → route menjawab "layanan data sedang tidak tersedia" (bukan
  hasil kosong) — error dilempar, tidak pernah diubah jadi 0.

Alasan deterministik: uji live menunjukkan kepatuhan model LLM terhadap format
tidak konsisten (data benar dari grounding, tapi format & array `products`
bervariasi). Pertanyaan non-filter tetap memakai jalur AI bila tersedia.

## Retensi konteks

- "hasil laut" lalu "di bawah 50000" → subjek "hasil laut" dipertahankan dari
  riwayat (maks 4 pesan user sebelumnya, divalidasi ulang ke DB).
- Subjek riwayat yang tidak menghasilkan apa pun (mis. "udang" yang kosong)
  **dilepas** agar jawaban melebar ke filter harga aktif.
- Subjek dari pesan sendiri tidak pernah dilepas (tetap ketat/jujur).
- Topik berubah (akun/statistik/layanan) → retensi tidak dipakai.

## File yang diubah

| File | Perubahan |
|---|---|
| `src/lib/ai.ts` | `ProductSubject`, `extractSubjectPhrase`, `canonicalSubject`, `matchSubjectToCategories`, `resolveProductSubject`, `countCatalog`, `describePriceFilterText`, `catalogProductLink`, `isSingleProductQuestion`; `filterConds()` bersama; komposer 1d/1e di `fallbackResult`; jalur deterministik di `generateReply`; STOPWORDS/`extractKeywords` (angka & kata filter dibuang); SYSTEM_PROMPT 27–29 |
| `src/lib/ai-context.ts` | resolusi + retensi subjek di `buildChatContext`; `fetchFilteredCountSection`; gate ringkasan katalog saat filter aktif; `detectIntents`: frasa harga → intent product; `ChatContext.filters`/`subjectAmbiguity`; bersihkan param `fetchReviews` tak terpakai |
| `src/app/api/ai/chat/route.ts` | kirim `recentUserMessages` (retensi), pakai `context.filters` final |
| `src/lib/ai.test.ts` | +30 test (ekstraksi subjek, sinonim, ambigu, komposer filter, deterministik, deskripsi tak ikut) |
| `src/lib/ai-context.test.ts` | +4 test (intent harga, hitungan berfilter) |
| `src/lib/ai-subject-db.test.ts` | baru: 11 test DB ter-mock (resolve/countCatalog/SQL AND + regresi precedence, error ≠ 0) |

Tidak ada perubahan layout/UI — `AIWidget.tsx` sudah merender `products[]`.

## Hasil verifikasi

- `npm run typecheck` — 0 error
- `npm run test` — **162/162 lulus** (117 sebelumnya + 45 baru; tidak ada
  regresi unit)
- `npm run lint` — 0 error (2 warning pre-existing di file lain)
- `npm run build` — 53 route OK
- **Uji live DB aktual** (login pembeli, 6 contoh wajib + retensi + hitungan +
  kosong + regresi): putaran pertama 30 PASS/5 FAIL (5 gagal format karena
  jalur AI) → setelah jalur deterministik: **19/19 PASS** di putaran ulang,
  sesi-bersih "maksimal 50000" → Minnow+Cumi (regresi harga utuh).
  Contoh hasil aktual: "hasil laut di bawah 50000" → hanya Cumi-cumi (45k);
  "hasil laut di atas 50000" → hanya Kerapu (85k); "ikan … di bawah 100000"
  → hanya Kerapu (Minnow tidak bocor dari deskripsi); "alat pancing di atas
  100000" → hanya Joran (150k); "…dari toko Hasil Laut Pak Budi di atas
  50000" → Kerapu; "berapa jumlah produk hasil laut?" → 2.

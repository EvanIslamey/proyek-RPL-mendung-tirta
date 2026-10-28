# Fitur Pengaturan Integrasi: WhatsApp & API Key AI

Ditambahkan ke halaman **Informasi Diri** yang sudah ada (tanpa menu navbar baru,
tanpa halaman baru), dan terhubung sungguhan ke backend chatbot.

## 1. Ringkasan UI

| Bagian | Halaman | Akses |
|---|---|---|
| Profil Saya (lama, utuh) | `/seller/profile`, `/admin/profile`, `/buyer` | sesuai role |
| **Pengaturan WhatsApp** (baru) | `/seller/profile`, `/admin/profile` | SELLER (miliknya), ADMIN (global) |
| **Pengaturan API Key** (baru) | `/admin/profile` | hanya ADMIN |
| **Status Koneksi & Riwayat Pengujian** (baru) | `/seller/profile`, `/admin/profile` | baris API Key disembunyikan untuk SELLER |

- Halaman pembeli (`/buyer` → "Informasi Diri") **tidak** menampilkan panel apa pun — BUYER tidak berwenang.
- Tombol per panel: WhatsApp → *Simpan Konfigurasi*, *Uji Koneksi*, *Kirim Pesan Uji*;
  API Key → *Simpan*, *Uji Koneksi*, *Aktifkan/Nonaktifkan*, *Hapus* (dengan konfirmasi 2-klik).
- Layout memakai grid `repeat(auto-fit, minmax(320px, 1fr))` sehingga responsif (desktop & mobile),
  mengikuti pola `dash-panel`/`dash-form-grid` yang sudah ada.

## 2. Otorisasi (dijalankan di BACKEND, bukan hanya UI)

| Role | WhatsApp | API Key AI |
|---|---|---|
| ADMIN | kelola konfigurasi **global** | kelola konfigurasi **global** |
| SELLER | kelola **miliknya sendiri** (`scope = userId`) | **403 ditolak** |
| BUYER | **403 ditolak** | **403 ditolak** |

Guard memakai `requireIntegrationUser()` (`src/lib/integrations.ts` → `requireUser` dari `auth.ts`),
dipakai di semua route `/api/settings/*`. Smoke test membuktikan setiap sel matriks di atas.

## 3. Keamanan credential

- **Enkripsi AES-256-GCM** (`src/lib/secret-store.ts`), kunci scrypt dari env
  `SECRET_ENCRYPTION_KEY` (server-side ONLY). Format penyimpanan `v1:<iv>:<tag>:<ct>`.
- **Frontend tidak pernah menerima nilai asli** — hanya `credentialHint` tersamarkan
  (`sk-••••••••ghij`) + flag `hasCredential`. Tidak ada di localStorage, tidak di log,
  tidak di pesan error (audit log hanya `user/role/service/provider/scope`).
- **Field credential dikosongkan = mempertahankan nilai lama** (tidak tertimpa kosong).
- **Aktivasi butuh validasi dulu**: mengaktifkan konfigurasi yang belum lolos uji koneksi
  ditolak backend (`setIntegrationActive` → `lastTestOk !== true` → 400). Perubahan
  credential/endpoint/model otomatis mereset status uji & menonaktifkan konfigurasi —
  konfigurasi aktif tidak pernah tertimpa oleh konfigurasi baru yang belum tervalidasi.
- Env hilang → `SECRET_ENCRYPTION_KEY` kosong → penyimpanan menolak dengan pesan jelas (bukan menyimpan plaintext).
- Rate limit: simpan 10/menit, uji koneksi 10/menit, kirim pesan uji 5/menit (per user).

## 4. Provider yang didukung

| Layanan | Provider | Cara uji |
|---|---|---|
| WHATSAPP | `meta-whatsapp-cloud` (Meta WhatsApp Cloud API, endpoint default `https://graph.facebook.com/v21.0`, dapat dioverride) | `GET {endpoint}/{phone-number-id}` dengan Bearer token |
| WHATSAPP (kirim uji) | sama | `POST {endpoint}/{id}/messages` — **hanya saat tombol ditekan**, nomor divalidasi E.164 (`+628…`) |
| AI_PROVIDER | `openai-compatible` (OpenAI, NVIDIA NIM, endpoint OpenAI-compatible lain) | `GET {base}/models` dengan Bearer key |

Adapter dirancang provider-agnostic (registry `WHATSAPP_PROVIDERS`/`AI_PROVIDERS` di
`integrations.ts`) — menambah provider lain cukup menambah entri registry + logika uji.

**Hasil uji selalu jujur:** permintaan dikirim server ke provider; kegagalan (401/403/timeout/jaringan)
ditampilkan apa adanya dan tersimpan di `lastTestAt/lastTestOk/lastTestNote`.
Terdapat temuan penting: endpoint `/models` NVIDIA mengembalikan **200 OK + katalog publik
meski key tidak valid**, sehingga verifikasi hanya berbasis status 200 akan menghasilkan
sukses palsu. Karena itu `testAiConnection` memverifikasi **material respons** (harus memuat
daftar model); respons 200 tanpa daftar model dilaporkan gagal.

## 5. Endpoint API (baru)

```
GET/PUT    /api/settings/whatsapp            # baca/simpan (ADMIN global, SELLER milik sendiri)
POST       /api/settings/whatsapp/test       # uji koneksi (backend-to-provider)
PUT        /api/settings/whatsapp/test       # kirim pesan teks uji (body: { to, text? })
GET/PUT/DELETE /api/settings/api-key         # hanya ADMIN
POST       /api/settings/api-key/test        # uji koneksi
POST       /api/settings/api-key/toggle      # aktifkan/nonaktifkan (guard validasi)
```

Semua: wajib login + `assertSameOrigin` (mutasi) + rate limit + sanitasi error tanpa kredensial.

## 6. Environment variables

| Var | Status | Fungsi |
|---|---|---|
| `SECRET_ENCRYPTION_KEY` | **BARU — wajib agar credential tersimpan** | kunci AES-256-GCM credential integrasi (sudah ditambahkan ke `.env` lokal & didokumentasikan di `.env.example`; `.env` di-gitignore) |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS` | sudah ada | fallback chatbot bila tidak ada konfigurasi DB aktif |

## 7. Penerapan pada chatbot (tanpa mengubah fitur lama)

- `generateReply` (`src/lib/ai.ts`) kini memakai `resolveAiRuntime()`:
  **konfigurasi AI AKTIF di DB → env → fallback katalog**. DB error / credential rusak
  tidak pernah membuat crash (fallback env tertangkap diam-diam).
- Jawaban tetap jujur: filter harga/subjek sengaja memakai jalur deterministik
  (`source=fallback`, desain fitur sebelumnya), jawaban kosong/gagal provider → fallback
  berbasis data — tidak ada jawaban AI palsu.
- **WhatsApp tidak dihubungkan ke pipeline notifikasi** (notifikasi tetap email + Telegram).
  Alasannya jujur: schema tidak punya nomor telepon user, dan menggandakan kiriman akan
  membuat notifikasi duplikat. Yang disediakan: konfigurasi + pengujian nyata siap pakai
  ketika nomor tujuan tersedia.
- **Anti pengiriman ganda:** pesan uji WhatsApp hanya terkirim saat tombol ditekan secara eksplisit.

## 8. Alur lokal (localhost)

1. `npm run db:server` (PGlite) — `npx prisma db push` menerapkan tabel `IntegrationConfig` (aditif, aman).
2. `npm run dev` — buka `/admin/profile` atau `/seller/profile`.
3. Isi form → **Simpan** → **Uji Koneksi** → (setelah lulus) **Aktifkan**.
4. **Catatan webhook (ditampilkan di UI):** localhost tidak dapat menerima webhook dari
   internet tanpa tunnel (mis. ngrok) atau endpoint publik. Fitur ini hanya menangani
   permintaan **keluar**; jangan mengekspos server lokal.

## 9. Hasil pengujian

| Lapisan | Hasil |
|---|---|
| Unit test (vitest) | **198/198 lulus** — 26 test integrations (validasi, matriks role, resolveAiRuntime, guard aktivasi, verifikasi material, sanitasi) + 10 test secret-store (roundtrip, tamper, tanpa plaintext, masking) + 162 test lama utuh |
| Smoke test live (`scripts/smoke-integrations.mts`) | **31/31 PASS** — 401 tanpa login, 403 BUYER/SELLER, persistensi setelah reload, hint tersamarkan, key mentah tidak pernah ada di respons/DB, key lama dipertahankan saat disimpan ulang, uji aktual, aktivasi tanpa validasi ditolak, chatbot tetap jawab (fallback), DB berisi ciphertext `v1:`, profil/password utuh |
| Verifikasi E2E chatbot (`scripts/verify-db-ai-config.mts`) | **9/9 PASS** — konfigurasi DB aktif benar-benar dipakai: jawaban datang dari mock provider, header `Authorization` memakai credential terdekripsi dari DB, nonaktifkan → kembali ke env, data uji dibersihkan |
| UI live (browser) | panel tampil di halaman profil ADMIN & SELLER; halaman BUYER bersih; navbar tanpa menu baru; simpan + reload persisten; hint `Tersimpan: sk-••••••••ghij`; kunci mentah tidak ada di DOM; uji koneksi menampilkan hasil aktual |
| `npm run typecheck` / `lint` / `build` | **bersih** — 0 error (2 warning lama di file yang tidak disentuh); build sukses dengan 5 route `/api/settings/*` terdaftar |

## 10. Yang membutuhkan kredensial eksternal

Fitur ini berfungsi penuh secara teknis; yang tidak bisa disimulasikan di lingkungan lokal:

1. **Pesan WhatsApp sungguhan terkirim** — butuh access token + Phone Number ID Meta yang
   valid (Meta Business Suite). Tanpa itu, "Uji Koneksi"/"Kirim Pesan Uji" akan jujur
   menampilkan kegagalan provider.
2. **Jawaban AI sungguhan dari konfigurasi DB** — butuh API key provider valid
   (via UI) atau env `AI_API_KEY`. Tanpa keduanya chatbot tetap berjalan mode fallback.
3. **Webhook WhatsApp masuk** — butuh endpoint publik/tunnel (lihat bagian 8).

## 11. Daftar file

**Baru:**
- `prisma/schema.prisma` (modifikasi aditif: enum `IntegrationService` + model `IntegrationConfig`)
- `src/lib/secret-store.ts` + `src/lib/secret-store.test.ts`
- `src/lib/integrations.ts` + `src/lib/integrations.test.ts`
- `src/app/api/settings/whatsapp/route.ts`, `.../whatsapp/test/route.ts`
- `src/app/api/settings/api-key/route.ts`, `.../api-key/test/route.ts`, `.../api-key/toggle/route.ts`
- `src/components/settings/WhatsAppSettingsPanel.tsx`, `ApiKeySettingsPanel.tsx`,
  `IntegrationStatusPanel.tsx`, `settings.css`
- `scripts/smoke-integrations.mts`, `scripts/verify-db-ai-config.mts`

**Dimodifikasi:**
- `src/lib/ai.ts` (baca runtime AI via `resolveAiRuntime`, fallback tak berubah)
- `src/app/seller/profile/page.tsx`, `src/app/admin/profile/page.tsx` (sisip 2–3 panel)
- `vitest.config.ts` (env kunci enkripsi khusus unit test), `.env.example`, `.gitignore`

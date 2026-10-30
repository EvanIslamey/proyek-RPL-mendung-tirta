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

**Validasi Phone Number ID (baru):** backend kini menolak Phone Number ID yang bukan
angka (`/^\d{5,25}$/`) — email admin atau nomor WhatsApp tujuan ditolak dengan pesan
jelas, sesuai ketentuan Meta (ID berupa angka dari App → WhatsApp → API Setup).

**Petunjuk template Meta (baru, tampil di UI):** panel Pengaturan WhatsApp menampilkan
instruksi: lokasi Phone Number ID & access token di dasbor Meta, kewajiban **template
disetujui** untuk pesan di luar jendela24 jam, kebutuhan opt-in penerima, serta catatan
webhook/localhost (butuh tunnel untuk menerima webhook masuk).

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
- **WhatsApp tidak dihubungkan ke pipeline notifikasi** (notifikasi tetap in-app + email +
  Telegram). Alasannya jujur: (a) schema tidak punya nomor telepon user — penerima tidak
  bisa ditentukan; (b) credential Meta belum diisi; (c) mengirim ke satu nomor uji akan
  membuat notifikasi ganda/salah sasaran. Yang disediakan: kanal siap uji (konfigurasi +
  pengujian nyata) dan keputusan penerima perlu ditentukan lebih dulu.
- **Anti pengiriman ganda:** pesan uji WhatsApp hanya terkirim saat tombol ditekan secara
  eksplisit, hanya bila konfigurasi aktif, nomor divalidasi E.164, dan rate-limited (5/menit).
- **Perbaikan anti-duplikasi notifikasi (baru):** `dispatchEmails` kini mengirim **Telegram
  hanya pada percobaan pertama** (`telegramSendOnce()` di `src/lib/notify.ts`) — retry
  email (baris FAILED → diklaim ulang) tidak lagi mengirim ulang notifikasi Telegram yang
  sama. Baris notifikasi tetap diklaim atomik (hanya satu pengirim), retry terbatas3×
  dengan backoff, dan kegagalan tidak pernah membatalkan pesanan.

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
| Unit test (vitest) | **205/205 lulus** — termasuk7 test baru `notify.test.ts` (Telegram hanya sekali saat retry, kebijakan preferensi, backoff, sanitasi error) |
| Smoke test live (`scripts/smoke-integrations.mts`) | **38/38 PASS** — semua cek lama utuh +7 cek baru WhatsApp: phoneId email/nomor ditolak, uji koneksi WA memberi hasil aktual provider (token uji ditolak Meta, bukan sukses palsu), kirim pesan uji saat konfigurasi nonaktif ditolak (tidak mengirim), nomor non-E.164 ditolak, uji tanpa konfigurasi jujur "belum disimpan" |
| Verifikasi E2E chatbot (`scripts/verify-db-ai-config.mts`) | **9/9 PASS** — konfigurasi DB aktif benar-benar dipakai: jawaban datang dari mock provider, header `Authorization` memakai credential terdekripsi dari DB, nonaktifkan → kembali ke env, data uji dibersihkan |
| Verifikasi NVIDIA (`scripts/verify-nvidia.mts`) | **LOLOS** — `GET /models`200 (85 model, model terkonfigurasi ada di daftar) + `POST /chat/completions`200 dengan balasan nyata (bukti key diterima; key tidak pernah dicetak) |
| Uji chatbot live (`scripts/test-chatbot-live.mts`) | **2/2 BERHASIL** — `source=ai` dengan konfigurasi aktif di DB (`resolveAiRuntime` → `source=db`); latensi3,3 dtk &22,6 dtk; uji grounding: pertanyaan "Siapa saya…" dijawab **data akun asli dari DB** (nama + tanggal daftar persis), tanpa mengarang |
| Setup config via API (`scripts/setup-ai-config.mts`) | **LOLOS** — simpan (hint `nva••••••••bUdd`, key mentah tidak ada di respons) → uji (`ok=true`,85 model) → aktifkan (guard lolos uji) → baca ulang persisten |
| UI live (browser) | panel tampil di halaman profil ADMIN & SELLER; halaman BUYER bersih; **navbar tanpa menu baru**; status koneksi menampilkan **"API Key AI … Aktif … Berhasil — Koneksi ke provider AI berhasil (85 model terdaftar)"**; badge panel "Aktif & teruji"; model `meta/llama-3.2-11b-vision-instruct` & Base URL NVIDIA tampil di form; Petunjuk Meta tampil; key mentah tidak ada di DOM |
| `npm run typecheck` / `lint` / `build` | **bersih** — typecheck0 error; lint0 error (2 warning lama di file yang tidak disentuh); build sukses dengan5 route `/api/settings/*` terdaftar |

## 10. Yang membutuhkan kredensial / keputusan manual

1. **Pesan WhatsApp sungguhan terkirim** — form Pengaturan WhatsApp masih menunggu isi Anda:
   - **Phone Number ID** — angka ID dari Meta Developer Dashboard → App → WhatsApp → API Setup
     (bukan email, bukan nomor tujuan; backend menolak format selain angka).
   - **Access token** — dari halaman Meta yang sama (token uji sementara atau permanen).
   - **Nomor WhatsApp tujuan (E.164)** — untuk tombol *Kirim Pesan Uji*.
   - Isi → **Simpan Konfigurasi** → **Uji Koneksi** → (setelah lolos) **Aktifkan** →
     **Kirim Pesan Uji**. Tanpa ini semua uji akan jujur menampilkan kegagalan provider.
2. **Notifikasi pesanan/pembayaran via WhatsApp** — butuh keputusan penerima: schema tidak
   punya nomor telepon user (perlu tambah field + pengisian di profil), ATAU kirim salinan
   notifikasi ke nomor admin (perlu persetujuan agar tidak dianggap notifikasi ganda).
3. **Webhook WhatsApp masuk** — butuh endpoint publik/tunnel (lihat bagian8). localhost tidak
   diekspos tanpa persetujuan.

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
- `scripts/verify-nvidia.mts` (cek ketersediaan model + bukti key diterima provider)
- `scripts/setup-ai-config.mts` (simpan/uji/aktifkan konfigurasi NVIDIA via API asli)
- `scripts/test-chatbot-live.mts` (uji chatbot live `source=ai` + bukti resolver DB)
- `scripts/bench-models.mts` (benchmark model terdaftar di akun — dasar pemilihan model)
- `scripts/inspect-config.mts` (inspeksi metadata config tersimpan, tanpa rahasia)
- `src/lib/notify.test.ts` (7 test anti-duplikasi notifikasi)

**Dimodifikasi:**
- `src/lib/ai.ts` (baca runtime AI via `resolveAiRuntime`, fallback tak berubah)
- `src/app/seller/profile/page.tsx`, `src/app/admin/profile/page.tsx` (sisip 2–3 panel)
- `src/lib/notify.ts` (Telegram hanya dikirim pada percobaan pertama — anti duplikat retry)
- `src/app/api/settings/whatsapp/route.ts` (Phone Number ID wajib angka Meta, tolak email/nomor)
- `src/components/settings/WhatsAppSettingsPanel.tsx` (Petunjuk Meta: lokasi ID/token,
  template 24 jam, opt-in, catatan webhook)
- `scripts/smoke-integrations.mts` (+7 cek WhatsApp)
- `vitest.config.ts` (env kunci enkripsi khusus unit test), `.env.example`, `.gitignore`

## 12. Koneksi NVIDIA NIM (laporan A)

- **API key DITEMUKAN di konfigurasi lokal** (`AI_API_KEY` di `.env`, ter-gitignore,
  panjang 70 karakter) — nilai tidak pernah dicetak/dilaporkan; key lama tidak ditimpa.
- **Endpoint:** `https://integrate.api.nvidia.com/v1` (base URL resmi NIM, sama dengan
  default `AI_PROVIDERS["openai-compatible"]`).
- **Konfigurasi aktif di DB** (disimpan via API asli, terenkripsi AES-256-GCM,
  hint `nva••••••••bUdd`): provider `openai-compatible` → uji koneksi `ok=true`
  (**85 model terdaftar**) → diaktifkan → chatbot memakainya
  (`resolveAiRuntime` → `source=db`; fallback env tetap utuh, tidak diubah).
- **Pemilihan model — diverifikasi, bukan ditebak.** `GET /models` di akun memuat 85 ID,
  tetapi uji `chat/completions` menunjukkan hanya 4 yang benar-benar dapat dilayani
  (12 kandidat lain **HTTP 404** meski terdaftar — "terdaftar ≠ tersedia"):

  | Kandidat | Hasil uji nyata |
  |---|---|
  | `openai/gpt-oss-20b` (konfigurasi lama) | ✅ jalan tapi **53–85 detik**; dengan timeout lama 45 dtk chatbot selalu terdorong ke fallback |
  | **`meta/llama-3.2-11b-vision-instruct`** | ✅ **dipilih** — tercepat & konsisten; via chatbot live: **3,3–22,6 detik**, `source=ai`, jawaban Indonesia berkualitas |
  | `minimaxai/minimax-m3.1-flash` | ✅ alternatif (31–34 dtk, output reasoning) |
  | `nvidia/nemotron-3.5-lightning-30b-a3b` | ⚠️ `finish=length` — jawaban terpotong |
  | `z-ai/glm-5.3-flash`, `deepseek-ai/deepseek-v4.1-flash`, `google/gemma-4-31b-it`, dll. | ❌ timeout 75 dtk / HTTP 404 |

- **`AI_TIMEOUT_MS` dinaikkan 45000 → 90000** di `.env` (rentang aman ≤ 120000) sebagai
  pengaman bila provider lambat — tanpa ini permintaan AI gagal diam-diam ke fallback.
- **Hasil uji:** uji koneksi backend `ok=true`; 2/2 permintaan chatbot live menghasilkan
  `source=ai` dengan jawaban provider nyata, termasuk bukti grounding: pertanyaan akun
  dijawab **data asli dari database** (nama + tanggal daftar persis) tanpa mengarang.

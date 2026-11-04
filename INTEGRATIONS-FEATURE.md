# Fitur Pengaturan Integrasi: WhatsApp (Fonnte), Telegram & API Key AI

Ditambahkan ke halaman **Informasi Diri** yang sudah ada (tanpa menu navbar baru,
tanpa halaman baru), dan terhubung sungguhan ke backend chatbot **dan pipeline
notifikasi per-role**.

> **Migrasi provider (Nov 2026):** Meta WhatsApp Cloud API **dihapus** — kini
> satu-satunya provider WhatsApp adalah **Fonnte WhatsApp Gateway**
> (`https://api.fonnte.com`). Field *Phone Number ID* & *Access Token Meta*
> tidak lagi ada; integrasi lama ditolak backend.

> **Panel Pengaturan Telegram (Nov 2026):** kartu Telegram berdekatan dengan
> panel Fonnte di Informasi Diri Administrator — Bot Token terenkripsi + Chat ID
> + uji koneksi getMe + kirim pesan uji + aktif/nonaktif, **independen** dari
> WhatsApp/Fonnte (lihat bagian 13).

## 1. Ringkasan UI

| Bagian | Halaman | Akses |
|---|---|---|
| Profil Saya (lama, utuh) | `/seller/profile`, `/admin/profile`, `/buyer` | sesuai role |
| **Pengaturan WhatsApp (Fonnte)** | `/seller/profile`, `/admin/profile` | SELLER (miliknya), ADMIN (global) |
| **Preferensi Notifikasi WhatsApp** (baru) | `/admin/profile`, `/seller/profile`, `/buyer` | semua role (nomor + persetujuan pribadi) |
| **Pengaturan API Key** | `/admin/profile` | hanya ADMIN |
| **Pengaturan Telegram** (baru) | `/admin/profile` | hanya ADMIN (global) |
| **Status Koneksi & Riwayat Pengujian** | `/seller/profile`, `/admin/profile` | baris API Key disembunyikan untuk SELLER |

- Panel Pengaturan WhatsApp memuat: **Provider** (Fonnte), **API Token** (input
  write-only — nilai tak pernah dikirim balik ke browser), **Nomor WhatsApp
  pengirim**, **Nomor tujuan pengujian**, **Penerima notifikasi operasional**
  (hanya ADMIN), **Status perangkat** (hasil *Uji Koneksi*), tombol
  *Simpan Konfigurasi* / *Uji Koneksi* / *Kirim Pesan Uji* /
  *Aktifkan–Nonaktifkan*, **Petunjuk Fonnte**, dan catatan webhook/localhost.
- Halaman pembeli **tidak** menampilkan panel integrasi apa pun (BUYER tidak
  berwenang) — hanya preferensi notifikasi pribadinya.
- Layout memakai grid `repeat(auto-fit, minmax(320px, 1fr))` (responsif),
  mengikuti pola `dash-panel`/`dash-form-grid` yang sudah ada.

## 2. Otorisasi (dijalankan di BACKEND, bukan hanya UI)

| Role | WhatsApp | API Key AI |
|---|---|---|
| ADMIN | kelola konfigurasi **global** + opsTargets | kelola konfigurasi **global** |
| SELLER | kelola **miliknya sendiri** (`scope = userId`) — `opsTargets` DI-STRIP | **403 ditolak** |
| BUYER | **403 ditolak** | **403 ditolak** |

Guard memakai `requireIntegrationUser()` (`src/lib/integrations.ts` → `requireUser`),
dipakai di semua route `/api/settings/*`. Smoke test membuktikan setiap sel matriks.

## 3. Keamanan credential (API Token Fonnte & API key AI)

- **Enkripsi AES-256-GCM** (`src/lib/secret-store.ts`), kunci scrypt dari env
  `SECRET_ENCRYPTION_KEY` (server-side ONLY). Format `v1:<iv>:<tag>:<ct>`.
- **Frontend tidak pernah menerima nilai asli** — hanya `credentialHint`
  tersamarkan + flag `hasCredential`. Tidak di localStorage, tidak di log server,
  tidak di pesan error; audit log hanya `user/role/service/provider/scope`.
  Token disembunyikan juga dari catatan hasil uji (`hideSecret`) dan log
  memakai masking ≥20 karakter alfanumerik (`clip`) agar token tak pernah bocor
  ke console.
- **Field credential dikosongkan = mempertahankan nilai lama** (bisa diperbarui
  tanpa menampilkan/menimpa token lama).
- **Aktivasi butuh uji koneksi lolos dulu** (`setIntegrationActive` →
  `lastTestOk !== true` → 400). Perubahan credential/endpoint otomatis
  menonaktifkan konfigurasi & mereset status uji.
- **Input client tak pernah dipercaya untuk status perangkat**: route membuang
  `phoneId` (sisa Meta) dan `device*` apa pun dari meta — status perangkat
  **hanya** berasal dari respons `POST /device` saat *Uji Koneksi* (anti-spoof).
- Rate limit: simpan 10/menit, uji koneksi 10/menit, kirim pesan uji (per user).

## 4. Provider WhatsApp: Fonnte

| Layanan | Provider | Cara uji / kirim |
|---|---|---|
| WHATSAPP | `fonnte` (endpoint default `https://api.fonnte.com`, dapat dioverride) | `POST {endpoint}/device` — header **`Authorization: <TOKEN>` tanpa Bearer**; sukses = profil perangkat dengan `device_status: "connect"` |
| WHATSAPP (kirim uji) | sama | `POST {endpoint}/send` — **body FormData** (`target`, `message`, `countryCode:"0"`, `preview:"false"`, `delay:"0"`, `typing:"false"`); sukses HANYA bila respons `status:true` |
| AI_PROVIDER | `openai-compatible` (NVIDIA NIM ds.) | `GET {base}/models` dengan Bearer key |

Detail implementasi (sesuai dokumentasi resmi docs.fonnte.com):

- **Token = device token Fonnte** (menu Device di dashboard Fonnte), dikirim
  mentah di header `Authorization` — bukan `Bearer …`.
- **Respons gagal Fonnte bisa memakai `status` ATAU `Status`** (casing tidak
  konsisten) — klien (`src/lib/fonnte.ts`) membaca keduanya plus
  `reason`/`message`/`detail`. **HTTP 200 saja tidak dianggap sukses** — body
  wajib `status:true`, jika tidak hasil uji = gagal dengan alasan provider.
- **`countryCode: "0"`** + `target` digit internasional tanpa `+`
  (`fonnteTarget` membuang non-digit). Validasi backend tetap E.164 `+62…`
  untuk semua nomor yang diizinkan user.
- **Timeout 20 dtk** per panggilan, tidak pernah melempar ke jalur transaksi —
  semua kegagalan jatuh ke status notifikasi `FAILED` (lihat bagian 7).
- **Endpoint lama Meta ditolak**: PUT dengan `provider: "meta-whatsapp-cloud"`
  → 400 `Provider tidak dikenali`.
- Adapter tetap provider-agnostic (registry `WHATSAPP_PROVIDERS`/`AI_PROVIDERS`);
  menambah provider lain cukup menambah entri registry + logika uji.

**Hasil uji selalu jujur:** permintaan dikirim server ke provider; kegagalan
(token salah, perangkat putus, kuota habis, jaringan mati) ditampilkan apa
adanya di `lastTestAt/lastTestOk/lastTestNote`. Untuk AI tetap berlaku temuan
lama: endpoint `/models` NVIDIA mengembalikan 200 OK + katalog publik meski key
tidak valid — karena itu `testAiConnection` memverifikasi material respons
(harus memuat daftar model).

## 5. Endpoint API

```
GET/PUT    /api/settings/whatsapp            # baca/simpan (ADMIN global, SELLER milik sendiri)
POST       /api/settings/whatsapp/test       # UJI KONESI perangkat (POST /device, snapshot status ke meta)
PUT        /api/settings/whatsapp/test       # kirim pesan teks uji (body { to?, text? }; fallback meta.testTarget)
POST       /api/settings/whatsapp/toggle     # aktifkan/nonaktifkan (guard: wajib lolos uji koneksi)
GET/PUT/DELETE /api/settings/api-key         # hanya ADMIN
POST       /api/settings/api-key/test        # uji koneksi
POST       /api/settings/api-key/toggle      # aktifkan/nonaktifkan (guard validasi)
GET/PATCH  /api/profile                      # field phone & whatsappNotify (preferensi WA per user)
GET/PUT    /api/settings/telegram            # baca/simpan — hanya ADMIN (GET = ensure-on-read, tanpa kirim)
POST       /api/settings/telegram/test       # UJI KONESI bot (getMe, verifikasi material ok+username)
PUT        /api/settings/telegram/test       # kirim pesan uji ke Chat ID tersimpan (tombol eksplisit)
POST       /api/settings/telegram/toggle     # aktifkan/nonaktifkan (guard: wajib lolos uji koneksi)
```

Semua: wajib login + `assertSameOrigin` (mutasi) + rate limit + sanitasi error
tanpa kredensial.

## 6. Environment variables

| Var | Status | Fungsi |
|---|---|---|
| `SECRET_ENCRYPTION_KEY` | wajib agar credential tersimpan | kunci AES-256-GCM credential integrasi (di `.env` lokal, gitignored) |
| `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS` | sudah ada | fallback chatbot bila tidak ada konfigurasi DB aktif |
| `TELEGRAM_BOT_TOKEN` | sudah ada (legacy) | fallback token bila panel belum menyimpan token sendiri; pada pembukaan pertama panel, nilai ini disalin terenkripsi ke DB (migrasi data lama) |
| `TELEGRAM_WEBHOOK_SECRET` | sudah ada | webhook linking Telegram (tidak disentuh fitur panel) |

Tidak ada env baru untuk Fonnte — token disimpan terenkripsi di DB
(`IntegrationConfig.credentialEnc`, scope global), diisi lewat form.
Telegram sama: **tidak ada env baru wajib** — token diisi lewat panel dan
disimpan terenkripsi; env `TELEGRAM_BOT_TOKEN` hanya sumber migrasi/fallback.

## 7. Notifikasi WhatsApp per role (kanal AKTIF di pipeline)

WhatsApp kini **terhubung penuh ke `notify.ts`** (kanal ke-4: in-app, email,
Telegram, **WhatsApp/Fonnte**) tanpa menduplikasi sistem notifikasi — baris
`Notification` yang sama dipakai, dengan metadata WA tambahan
(`waStatus/waAttempts/waNextAt/waError` + index).

- **Sumber konfigurasi:** hanya config **global admin** (scope `""`) yang
  aktif. Penerima operasional = `meta.opsTargets` (daftar nomor comma-list,
  divalidasi E.164, hanya ADMIN yang bisa mengaturnya).
- **Peran penerima** (dipanggil dari call site transaksi `orders.ts`/`auth.ts`):
  - **ADMIN** — pesanan baru, pembayaran dikonfirmasi, pengguna baru terdaftar,
    pembatalan & perubahan status (aktivitas penting). Baris admin dibuat untuk
    SEMUA admin, tetapi **tepat satu** yang layak terkirim per kejadian
    (anti-ganda) — plus satu pesan ke pasangan `opsTargets` (dua nomor dalam
    **SATU** request, dipisah koma).
  - **BUYER** — pesanan dibuat, dibayar, diproses/dikirim, selesai/dibatalkan.
  - **SELLER** — pesanan baru untuk produknya, pembayaran, perubahan status,
    dibatalkan.
- **Nomor & persetujuan:** nomor dari field profil `User.phone` (wajib format
  internasional Indonesia `+62…` / E.164, divalidasi backend saat simpan);
  pengiriman **hanya** bila `User.whatsappNotify = true` (opt-in eksplisit di
  panel *Preferensi Notifikasi WhatsApp*). Tanpa nomor / tanpa persetujuan →
  baris `waStatus = SKIPPED` **permanen** (diputus saat pembuatan *dan* dicek
  ulang tepat sebelum kirim).
- **Anti-duplikasi:** unique constraint `(userId, dedupeKey)` di DB + klaim
  atomik `waStatus` PENDING→SENDING (hanya satu pengirim per baris) + pemilihan
  satu baris admin per kejadian. Tidak ada pesan ganda per kejadian.
- **Riwayat:** setiap baris mencatat `waStatus` (PENDING/SENDING/SENT/FAILED/
  SKIPPED), `waAttempts`, `waNextAt` (backoff, maksimal 3 percobaan), dan
  `waError` (alasan aman — tanpa token/nomor penuh, nomor dimasking).
- **Kegagalan WA ≠ kegagalan transaksi:** pengiriman berjalan asinkron setelah
  transaksi sukses; token salah / perangkat putus / kuota habis hanya
  menghasilkan baris `FAILED` — order tetap tercipta, terbayar, bisa dibatalkan
  (dibuktikan smoke-fonnte bagian C).
- **Keamanan pesan:** URL absolut disertakan hanya bila `APP_URL` publik
  (bukan localhost); pesan dipotong 4000 karakter; pesan uji hanya terkirim
  saat tombol ditekan + config aktif + rate-limited.
- Anti-duplikasi Telegram lama (`telegramSendOnce`) tetap utuh.

## 8. Alur lokal (localhost) + menghubungkan perangkat Fonnte

1. `npm run db:server` (PGlite) — skema sudah ter-push (field `User.phone`,
   `User.whatsappNotify`, kolom `Notification.wa*` aditif, aman).
2. `npm run dev` — buka `/admin/profile` (global) atau `/seller/profile`.
3. **Hubungkan perangkat Fonnte (sekali saja):**
   1. Daftar/login di **dashboard Fonnte** (fonnte.com).
   2. Buka menu **Device** → tombol **Connect** → **scan QR** dari WhatsApp
      di ponsel (WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat).
   3. Tunggu status `device_status: connect` di dasbor Fonnte.
   4. Salin **token** dari menu Device (device token / token sesuai paket Fonnte).
4. Di panel Pengaturan WhatsApp: isi **API Token**, **Nomor WhatsApp pengirim**
   (`+62…`), **Nomor tujuan pengujian**, (admin) **penerima operasional** →
   **Simpan Konfigurasi** → **Uji Koneksi** (status perangkat tampil) →
   (setelah lolos) **Aktifkan** → **Kirim Pesan Uji**.
5. Pengguna atur nomor & persetujuan masing-masing di panel **Preferensi
   Notifikasi WhatsApp** di Informasi Diri mereka.
6. **Catatan webhook:** localhost tidak menerima webhook internet tanpa tunnel
   — fitur ini hanya permintaan **keluar**; jangan mengekspos server lokal
   tanpa persetujuan.

## 9. Hasil pengujian

| Lapisan | Hasil |
|---|---|
| Unit test (vitest) | **251/251 lulus** (11 file) — termasuk 19 test baru `fonnte.test.ts` (fonnteTarget, pembacaan `status`/`Status`, /device, /send FormData + Authorization tanpa Bearer, hideSecret/clip, timeout, tidak melempar) + test notify (helper WA: `isIndonesiaMobile`/`isE164`/`parseOpsTargets`/`maskPhone`/`buildWaMessage`/retry) + test integrations (shape registry provider, validasi nomor,5 kasus `testWhatsAppConnection` — sukses nyata, `status:false`, device disconnect, provider Meta lama ditolak tanpa fetch, token kosong) + **8 test Telegram baru** (scope `TELEGRAM`: ADMIN global, SELLER/BUYER ditolak; registry `telegram-bot`; `toSafeConfig` label + meta non-rahasia tanpa field token; `testTelegramConnection` getMe sukses/`Unauthorized`/tanpa token — token tak pernah masuk note; `telegramGateAllows` gerbang notifikasi) |
| Smoke Fonnte (`scripts/smoke-fonnte.mts`) | **47/47 PASS** — mock server Fonnte lokal dengan4 model token: simpan token (terenkripsi, tak bocor), uji koneksi sukses + snapshot perangkat, FormData `countryCode=0` tanpa Bearer, nomor non-E.164 ditolak tanpa request keluar, token salah → `token invalid`, perangkat disconnect → meta `deviceStatus=disconnect`, kuota habis (`Status` huruf besar) → kirim gagal jujur, endpoint mati → "Gagal menghubungi Fonnte", guard Aktifkan; notifikasi per role via pipeline asli (BUYER/SELLER tanpa persetujuan → SKIPPED; setelah opt-in → SENT; ADMIN tepat satu pesan per kejadian ke ops pair; total pengiriman persis6 — tanpa pesan ganda/massal); kegagalan WA (kuota/token salah) **tidak menggagalkan order** (201, bayar, batal tetap sukses; `waStatus=FAILED` beralasan); snapshot/restore penuh (order uji dihapus, phone/stok/profil dipulihkan, config AI utuh) — **fix Nov 2026: baris WA asli kini di-snapshot & dipulihkan** (sebelumnya `deleteMany` baris WA tanpa restorasi), 47/47 PASS ×3 run |
| Smoke integrasi live (`scripts/smoke-integrations.mts`) | **66/66 PASS** — otorisasi 3 role; simpan Fonnte; `phoneId`/`device*`/`opsTargets` spoof DIBERSIHKAN backend (scope seller di-strip); validasi E.164 (testTarget/senderNumber/opsTargets); uji koneksi WA ke Fonnte sungguhan → ditolak jujur dengan token uji (bukan sukses palsu); kirim uji nonaktif & fallback `to`; provider Meta lama ditolak 400; guard toggle; preferensi profil (`+62`, opt-in tanpa nomor ditolak, hapus nomor → opt-in nonaktif); regresi API key & profil utuh; **snapshot/restore: config AI NVIDIA aktif dipulihkan di akhir run** |
| Verifikasi E2E chatbot (`scripts/verify-db-ai-config.mts`) | **9/9 PASS** — konfigurasi DB aktif dipakai chatbot (jawaban mock provider, credential terdekripsi dari DB, nonaktifkan → kembali ke env, data uji dibersihkan) |
| Uji chatbot live (`scripts/test-chatbot-live.mts`) | **2/2 BERHASIL** — `source=ai` dengan config aktif di DB (`resolveAiRuntime → source=db`), latensi 6,6 dtk & 5,8 dtk; pertanyaan akun dijawab **data asli dari DB** tanpa mengarang |
| Verifikasi NVIDIA (`scripts/verify-nvidia.mts`) | **LOLOS** — `GET /models` 200 (85 model) + `POST /chat/completions` **200 dengan balasan nyata** (key tidak pernah dicetak) |
| Setup config via API (`scripts/setup-ai-config.mts`) | **LOLOS** — simpan (hint `nva••••••••bUdd`, key mentah tidak ada di respons) → uji (`ok=true`, 85 model) → aktifkan (guard lolos uji) → baca ulang persisten |
| API Telegram live (curl, sesi Nov 2026) | GET → baris dibuat via ensure-on-read (env `TELEGRAM_BOT_TOKEN` tersalin terenkripsi, hint `890••••••••ZAj8`, `isActive=true`, **tanpa token di respons**) → POST test getMe **`ok=true` `@MendungTirtaNotifBot`** → simpan Chat ID invalid → 400 field error; simpan valid → meta **merge** (`botUsername` terjaga) → toggle OFF/ON **WhatsApp tetap `isActive=true`** (independensi) → kirim pesan uji ke Chat ID dummy → respons **asli** Telegram `Bad Request: chat not found` (jalur kirim terbukti pakai token tersimpan; `lastSentAt` hanya tercatat saat sukses) → hapus Chat ID → meta bersih |
| UI live (browser) | `/admin/profile`: panel "Pengaturan WhatsApp" menampilkan **Provider: Fonnte WhatsApp Gateway**, API Token, nomor pengirim/tujuan/ops, Status perangkat, Petunjuk Fonnte, **5 tombol** (Simpan/Uji Koneksi/Kirim Pesan Uji/Aktifkan/Nonaktifkan); **tidak ada** lagi teks *Phone Number ID*/*Access Token*/*meta-whatsapp-cloud*; panel API Key AI & Status Koneksi utuh; panel **Preferensi Notifikasi WhatsApp** tampil; DOM **tanpa token mentah**; **panel "Pengaturan Telegram" tampil berdekatan** (badge "Aktif & teruji", Bot Token hint `890••••••••ZAj8`, Chat ID, 4 tombol, tanpa kebocoran token di DOM); `/buyer`: hanya preferensi notifikasi (tanpa panel integrasi) |
| `npm run typecheck` / `lint` / `build` | **bersih** — typecheck 0 error; lint 0 error (2 warning lama di file yang tidak disentuh); build sukses dengan route `/api/settings/whatsapp`, `/whatsapp/test`, `/whatsapp/toggle`, `/api/profile` terdaftar |

## 10. Yang membutuhkan tindakan manual

1. **API Token Fonnte asli** — form Pengaturan WhatsApp menunggu token Anda
   (di situs ini hanya diuji dengan mock & token uji palsu; tidak ada token
   asli yang diketik/dikomit/ditampilkan):
   - Masuk dashboard Fonnte → menu **Device** → **Connect** → scan QR
     (WhatsApp → Setelan → Perangkat Tertaut) → salin token → isi form →
     **Simpan** → **Uji Koneksi** → **Aktifkan** → **Kirim Pesan Uji**.
   - Isi **nomor tujuan pengujian** (`+62…`) dan (admin) **penerima
     operasional** notifikasi.
2. **Nomor & persetujuan tiap pengguna** — pengisian mandiri di panel
   *Preferensi Notifikasi WhatsApp*; tanpa nomor `+62…` + centang persetujuan,
   pengguna otomatis `SKIPPED` (tidak pernah diganggu).
3. **Webhook masuk** — butuh endpoint publik/tunnel (bagian 8); localhost tidak
   diekspos tanpa persetujuan.
4. **Chat ID Telegram** — bot belum pernah menerima pesan (tidak ada Chat ID
   tersimpan di DB, `getUpdates` terkunci webhook linking). Untuk membuktikan
   *pesan uji benar-benar diterima*: chat bot (mis. `@MendungTirtaNotifBot`) →
   kirim pesan apa pun → ambil ID via `@userinfobot` → isi **Chat ID** di panel
   → Simpan → Uji Koneksi → Aktifkan → **Kirim Pesan Uji**.

## 11. Daftar file

**Baru (Fonnte):**
- `src/lib/fonnte.ts` + `src/lib/fonnte.test.ts` (klien Fonnte resmi: /device,
  /send FormData, pembacaan `status`/`Status`, masking token)
- `src/app/api/settings/whatsapp/toggle/route.ts`
- `src/components/settings/WhatsAppPreferencesPanel.tsx`
- `scripts/smoke-fonnte.mts` (mock Fonnte lokal,47 cek)

**Baru (Telegram):**
- `src/app/api/settings/telegram/route.ts` (GET ensure-on-read + PUT simpan
  token/chat ID, merge meta server-side)
- `src/app/api/settings/telegram/test/route.ts` (POST getMe, PUT kirim pesan uji)
- `src/app/api/settings/telegram/toggle/route.ts` (guard lolos uji)
- `src/components/settings/TelegramSettingsPanel.tsx` (kartu panel admin)

**Baru (sesi integrasi sebelumnya, tetap):**
- `src/lib/secret-store.ts` + test; `src/lib/integrations.ts` + test
- `src/app/api/settings/whatsapp/route.ts`, `.../whatsapp/test/route.ts`
- `src/app/api/settings/api-key/route.ts`, `.../api-key/test`, `.../api-key/toggle`
- `src/components/settings/ApiKeySettingsPanel.tsx`, `IntegrationStatusPanel.tsx`, `settings.css`
- `scripts/verify-db-ai-config.mts`, `verify-nvidia.mts`, `setup-ai-config.mts`,
  `test-chatbot-live.mts`, `bench-models.mts`, `inspect-config.mts`

**Dimodifikasi (Fonnte):**
- `prisma/schema.prisma` — `User.phone`, `User.whatsappNotify`;
  `Notification.waStatus/waAttempts/waNextAt/waError` + index (`prisma db push` aditif)
- `src/lib/integrations.ts` — provider `fonnte`, hapus `needsPhoneId`,
  `testWhatsAppConnection` → `/device`, `recordWhatsAppDeviceMeta`,
  `sendWhatsAppTestMessage` → `/send`, `isValidIndonesiaMobile`
- `src/lib/notify.ts` — kanal WhatsApp lengkap (eligibility per role, consent,
  claim atomik, kirim Fonnte, retry/backoff, sanitasi error & masking nomor)
- `src/lib/orders.ts` — call site notifikasi admin/seller
  (`createOrder`/`payOrder`/`cancelOrderCore`/`setOrderStatus`)
- `src/lib/auth.ts` — alert admin untuk pembeli baru terdaftar
- `src/app/api/settings/whatsapp/route.ts` — default provider fonnte, buang
  `phoneId`/`device*`, validasi `testTarget`/`senderNumber`/`opsTargets` E.164
- `src/app/api/settings/whatsapp/test/route.ts` — sesuai dok Fonnte + fallback `to`
- `src/app/api/profile/route.ts` — GET/PATCH `phone` + `whatsappNotify` (invarian)
- `src/components/settings/WhatsAppSettingsPanel.tsx` — ditulis ulang ke Fonnte
  (token masked, status perangkat, ops, Petunjuk Fonnte, tombol toggle)
- `src/app/admin/profile/page.tsx` (`showOps`), `src/app/seller/profile/page.tsx`,
  `src/app/buyer/page.tsx` — sisip panel preferensi
- `scripts/smoke-integrations.mts` — 66 cek Fonnte + **snapshot/restore config AI**
- `src/lib/notify.test.ts`, `src/lib/integrations.test.ts` — test WA tambahan
- `.env` — `AI_MODEL` diganti `minimaxai/minimax-m3.1-flash` (lihat bagian 12)
- `INTEGRATIONS-FEATURE.md` (dokumen ini)

**Dimodifikasi (Telegram):**
- `prisma/schema.prisma` — enum `IntegrationService` += `TELEGRAM` (`db push` aditif, tanpa tabel baru)
- `src/lib/telegram.ts` — `telegramApi`/`sendTelegramMessage` menerima token override backend-only
- `src/lib/integrations.ts` — registry `TELEGRAM_PROVIDERS`, cabang `toSafeConfig`, `scopeForUser` (SELLER ditolak), `resolveTelegramToken` (DB → fallback env), `testTelegramConnection` (getMe), `ensureTelegramConfig` (migrasi env + chat ID admin), `runTelegramTest`, `sendTelegramTestMessage`, `recordTelegramMeta`
- `src/lib/notify.ts` — gerbang `telegramGateAllows`/`isTelegramChannelEnabled` di `dispatchEmails` & `alertAdminsEmailFailed` (tanpa baris config → perilaku lama)
- `src/app/admin/profile/page.tsx` — sisip `<TelegramSettingsPanel />` setelah panel Fonnte
- `scripts/smoke-fonnte.mts` — **fix**: snapshot & restorasi baris WA asli (bug restore lama menghapus konfigurasi asli permanen) + check "nyangkut SENDING" menunggu dispatch selesai (race)

## 12. Koneksi NVIDIA NIM (laporan A — tetap aktif)

- **API key DITEMUKAN di konfigurasi lokal** (`AI_API_KEY` di `.env`, ter-gitignore,
  panjang 70 karakter) — nilai tidak pernah dicetak/dilaporkan; key lama tidak ditimpa.
- **Endpoint:** `https://integrate.api.nvidia.com/v1`.
- **Konfigurasi aktif di DB** (disimpan via API asli, terenkripsi AES-256-GCM,
  hint `nva••••••••bUdd`): provider `openai-compatible` → uji koneksi `ok=true`
  (**85 model terdaftar**) → diaktifkan → chatbot memakainya
  (`resolveAiRuntime` → `source=db`; fallback env tetap utuh).
- **Perubahan model (Nov 2026):** model lama `meta/llama-3.2-11b-vision-instruct`
  kini mengembalikan **HTTP 404 permanen** di `/chat/completions` (masih
  terdaftar di `/models` — pola "terdaftar ≠ tersedia" yang sama seperti temuan
  awal), sehingga chatbot jatuh ke fallback. Setelah probe ulang seluruh
  kandidat, dipilih **`minimaxai/minimax-m3.1-flash`** (200 OK, ~4–7 detik,
  balasan nyata); diverifikasi `verify-nvidia` LOLOS + chatbot live 2/2
  `source=ai`. Kandidat lain tetap tak layak: `openai/gpt-oss-20b` timeout
  50+ dtk, `nvidia/nemotron-3.5-lightning-30b-a3b` output kosong.
  `AI_MODEL` di `.env` ikut diperbarui agar fallback env tidak menunjuk model mati.
- **`AI_TIMEOUT_MS` dinaikkan 45000 → 90000** di `.env` (rentang aman ≤ 120000).
- **Hasil uji terakhir:** uji koneksi `ok=true`; chatbot live `source=ai`
  dengan jawaban provider nyata, termasuk grounding akun (nama + tanggal
  daftar persis dari database) tanpa mengarang.

## 13. Pengaturan Telegram (panel admin, provider independen)

**Penyebab "menu Telegram hilang" (hasil audit, Nov 2026):** menu/kartu
"Pengaturan Telegram" **memang tidak pernah ada** — `git log -S "Pengaturan
Telegram"` / `"TELEGRAM_CHAT_ID"` kosong dan tidak ada file terhapus. Yang ada
hanya fitur *linking* Telegram per-user (`User.telegramChatId` via webhook +
`/api/telegram/*`) dan pengiriman notifikasi memakai env `TELEGRAM_BOT_TOKEN`.
`TELEGRAM_CHAT_ID` tidak pernah ada di HEAD (chat ID bersifat per-user).
Panel ini adalah fitur BARU, bukan pemulihan komponen lama.

**Arsitektur (tanpa tabel/endpoint duplikat):**
- Enum `IntegrationService` += `TELEGRAM` → satu baris config global
  (scope `""`) di tabel `IntegrationConfig` yang sama, kolom yang sama.
- Endpoint baru hanya 3 jalur fungsional: `/api/settings/telegram`
  (GET/PUT), `/telegram/test` (POST getMe / PUT kirim uji),
  `/telegram/toggle` (POST). Linking/unlink/preferensi/webhook lama
  (`/api/telegram/*`) tetap — beda fungsi, tidak diduplikasi.
- **Ensure-on-read:** GET membuat baris bila belum ada — menyalin token env
  `TELEGRAM_BOT_TOKEN` ke `credentialEnc` terenkripsi (**migrasi data lama**),
  Chat ID dari admin yang sudah link, `isActive = Boolean(token env)`
  (mempertahankan keadaan notifikasi lama). Murni baca/simpan, tanpa kirim.
- **Token:** `resolveTelegramToken` = decrypt DB → fallback env → null.
  Tidak pernah tampil utuh (hanya hint `maskSecret`), tidak pernah di log,
  tidak pernah di respons/frontend; error disaring `sanitizeProviderNote`
  (kata `Unauthorized`/deskripsi 40+ karakter → dipetakan ke pesan ramah).
- **Gerbang notifikasi (`notify.ts`):** `telegramGateAllows(null) = true`
  (baris belum ada = perilaku lama, panel belum dibuka) — diterapkan di
  `dispatchEmails` & `alertAdminsEmailFailed`. Baris ada → ikuti `isActive`.
  DB error → tetap kirim (jangan mematikan kanal lama). Kegagalan Telegram
  tidak pernah memengaruhi Fonnte/WA/email, dan sebaliknya.
- **Guard & rate limit:** aktifkan hanya bila uji getMe terakhir lolos
  (backend, tak bisa dipalsukan); uji 10/menit & kirim uji 5/menit per user;
  kirim uji hanya via tombol + config aktif + Chat ID valid (`/^-?\d+$/`).
- `lastSentAt` & `botUsername` disimpan di `meta` **server-side** (di-strip
  dari input client, dipertahankan saat simpan lewat merge) — sumber "waktu
  pengiriman terakhir" di panel.

**Status pengujian live:** getMe sukses `@MendungTirtaNotifBot`; jalur kirim
terbukti memanggil API Telegram asli (respons `chat not found` untuk ID dummy);
toggle Telegram OFF/ON tidak mengubah status Fonnte. **Langkah manual tersisa:**
isi Chat ID asli (bagian 10 poin 4) lalu tekan *Kirim Pesan Uji* untuk
membuktikan pesan diterima di aplikasi Telegram.

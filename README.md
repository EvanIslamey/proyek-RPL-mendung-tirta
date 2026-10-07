# Mendung Tirta

Marketplace lokal untuk **hasil panen laut segar** dan **perlengkapan memancing** — menghubungkan nelayan/pembudidaya dengan pembeli rumah tangga, restoran, dan pemancing. Dibangun dengan Next.js (App Router), Prisma ORM, dan PostgreSQL.

## Daftar Isi

- [Fitur](#fitur)
- [Teknologi](#teknologi)
- [Memulai](#memulai)
- [Perintah Berguna](#perintah-berguna)
- [Struktur Proyek](#struktur-proyek)
- [Arsitektur & Keamanan](#arsitektur--keamanan)
- [Pengujian](#pengujian)
- [Akun Demo](#akun-demo)
- [Deployment](#deployment)
- [Keterbatasan yang Diketahui](#keterbatasan-yang-diketahui)

## Fitur

| # | Tahap | Status |
|---|-------|--------|
| 1 | Setup proyek (Next.js 16 + Prisma 7 + TypeScript) | ✅ |
| 2 | Database (skema 9 model, migrasi, seed) | ✅ |
| 3 | Autentikasi (register/login/logout, sesi cookie, rate limit) | ✅ |
| 4 | Marketplace (katalog, pencarian, filter, sort, paginasi, detail + ulasan) | ✅ |
| 5 | Dashboard penjual (statistik, kelola toko/produk/pesanan) | ✅ |
| 6 | Keranjang & checkout (localStorage + transaksi server-side) | ✅ |
| 7 | Profil pembeli (ubah profil & password, riwayat pesanan) | ✅ |
| 8 | Asisten AI (chat grounding katalog, widget floating, fallback) | ✅ |
| 9 | Dashboard admin (pengguna, toko, kategori, moderasi, pesanan, ulasan) | ✅ |
| 10 | Pencarian & rekomendasi (sort, produk serupa, saran AI) | ✅ |
| 11 | UI/UX (responsive, hamburger mobile, loading/empty/error state, toast) | ✅ |
| 12 | Pengujian & audit (unit test, smoke test E2E, lint, build) | ✅ |

Detail teknis tiap fitur ada di [Arsitektur & Keamanan](#arsitektur--keamanan).

## Teknologi

- **Next.js 16.3.4** — App Router, Server Components, `proxy.ts` (pengganti `middleware.ts`)
- **React 19** + TypeScript (strict)
- **Prisma 7** dengan driver adapter `@prisma/adapter-pg` (client di-generate ke `prisma/generated/`)
- **PostgreSQL** — lokal: PGlite via socket (`npm run db:server`); produksi: PostgreSQL apa pun
- **Autentikasi** sendiri: sesi cookie `httpOnly` + token SHA-256 di DB + bcrypt
- **vitest** untuk unit test, skrip `tsx` untuk smoke test E2E

## Memulai

```bash
# 1. Install dependensi (postinstall otomatis menjalankan prisma generate)
npm install

# 2. Siapkan environment
cp .env.example .env
#     → untuk lokal cukup aktifkan baris DATABASE_URL PGlite (lihat .env.example)

# 3. Jalankan database lokal (terminal 1) — PGlite socket di port 55432/55433
npm run db:server

# 4. Terapkan migrasi & data demo (terminal 2)
npx prisma migrate deploy
npm run db:seed

# 5. Jalankan aplikasi
npm run dev
```

Buka [http://localhost:3000](http://localhost:3000).

> **Catatan migrasi:** proyek ini memakai alur `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script --output prisma/migrations/<nama>/migration.sql` lalu `npx prisma migrate deploy`. `prisma migrate dev` tidak dipakai karena tidak kompatibel dengan PGlite lokal. Jalankan `npm run db:seed` kapan pun untuk mengembalikan data demo ke kondisi awal (seed idempoten).

### Environment Variables

| Variabel | Wajib | Keterangan |
|----------|-------|------------|
| `DATABASE_URL` | ✅ | Koneksi PostgreSQL (`postgresql://user:pass@host:port/db`) |
| `SHADOW_DATABASE_URL` | – | Hanya untuk `prisma migrate dev` (tidak dipakai di alur ini) |
| `NEXT_PUBLIC_APP_URL` | – | URL publik aplikasi |
| `AI_API_KEY` | – | API key provider AI **hanya untuk backend** (jangan pakai prefiks `NEXT_PUBLIC_`) |
| `AI_BASE_URL` | – | Endpoint OpenAI-compatible (default `https://api.openai.com/v1`) |
| `AI_MODEL` | – | Nama model (default `gpt-4o-mini`) |

Tanpa `AI_API_KEY`, asisten AI tetap berjalan dalam **mode katalog** (fallback berbasis pencarian database) dan pengguna diberi tahu bahwa jawaban berasal dari pencarian katalog.

## Perintah Berguna

| Perintah | Fungsi |
|----------|--------|
| `npm run dev` | Development server |
| `npm run build` | Build produksi |
| `npm run start` | Jalankan build produksi |
| `npm run lint` | ESLint (harus 0 problem) |
| `npm run typecheck` | TypeScript `--noEmit` |
| `npm run test` | Unit test (vitest) |
| `npm run db:server` | Database lokal PGlite via socket |
| `npm run db:seed` | Seed/reset data demo (idempoten) |
| `npx prisma migrate deploy` | Terapkan migrasi |
| `npx prisma studio` | GUI database |

## Struktur Proyek

```
mendung-tirta/
├── prisma/
│   ├── schema.prisma          # 9 model + enum OrderStatus/PaymentStatus
│   ├── migrations/            # SQL migrasi (001 awal, 002 order/payment/admin)
│   ├── seed.ts                # Data demo (idempoten)
│   └── generated/             # Prisma client (hasil generate, jangan diedit)
├── scripts/
│   ├── pglite-server.ts       # DB lokal via @electric-sql/pglite-socket
│   ├── smoke-auth.mts         # Smoke test auth (22 cek)
│   ├── smoke-marketplace.mts  # Smoke test katalog/checkout/review (39 cek)
│   ├── smoke-profile-ai.mts   # Smoke test profil/guard/AI (34 cek)
│   └── smoke-admin.mts        # Smoke test dashboard admin (53 cek)
└── src/
    ├── proxy.ts               # Guard Next 16 (cek keberadaan cookie sesi)
    ├── app/
    │   ├── page.tsx           # Landing page
    │   ├── products/          # Katalog + detail produk + ulasan
    │   ├── cart/ checkout/    # Keranjang & checkout
    │   ├── orders/            # Riwayat pesanan pembeli
    │   ├── buyer/             # Profil pembeli (guard role)
    │   ├── seller/            # Dashboard penjual (guard role)
    │   ├── admin/             # Dashboard admin (guard role)
    │   └── api/               # 25+ route handler (lihat tiap folder)
    ├── components/            # UI bersama (ProductCard, Modal, Toast, AIWidget, …)
    └── lib/                   # auth, orders, catalog, ai, validate, rate-limit, …
```

## Arsitektur & Keamanan

### Autentikasi & Sesi
- Register menerima peran `BUYER`/`SELLER` (permintaan `ADMIN` selalu jatuh ke `BUYER` — anti privilege escalation; toko dibuat otomatis saat daftar sebagai penjual).
- Sesi: cookie `mt_session` (`httpOnly`, `SameSite=Lax`, `secure` saat produksi) berisi token acak; di DB hanya disimpan **hash SHA-256**-nya, dengan masa berlaku.
- Password di-hash bcrypt (cost 10). Login menyamakan waktu respons untuk email yang tidak terdaftar (anti user-enumeration).
- Ganti password menarik semua sesi di perangkat lain.
- Akun yang dinonaktifkan admin kehilangan akses seketika (dicek di setiap pembacaan sesi).

### Otorisasi (RBAC)
- **Lapisan 1 — `src/proxy.ts`**: cek keberadaan cookie untuk rute proteksi (redirect ke `/login?next=…` untuk halaman, `401` untuk API). Cepat, tapi **bukan** otorisasi final.
- **Lapisan 2 — layout server** (`/seller`, `/admin`, `/buyer`): `getSessionUser()` + cek role, redirect sesuai peran.
- **Lapisan 3 — setiap route handler**: `requireUser()` / `requireRole("SELLER"|"ADMIN")` + pemeriksaan kepemilikan resource (`requireOwnProduct`, dsb.) untuk mencegah IDOR.

### Anti-oversell & Transaksi
- Checkout dihitung ulang **di server** (harga & stok dari DB, bukan kiriman client) di dalam `prisma.$transaction` dengan `updateMany({ where: { id, stock: { gte: qty } } })` — dua pembeli bersamaan tidak bisa menjual melebihi stok.
- Pembatalan pesanan (pembeli/penjual/admin) mengembalikan stok dalam transaksi juga.

### Pembayaran
- MVP **dummy**: `POST /api/orders/[id]/pay` menandai `Payment PAID` + order `PROCESSING`. Integrasi gateway sungguhan (Midtrans/dll.) adalah penggantian yang dirancang di titik ini.

### Status Pesanan
- Peta transisi tunggal `ORDER_TRANSITIONS` di `src/lib/orders.ts` (divalidasi unit test): `PENDING → PROCESSING → SHIPPED/READY_FOR_PICKUP → COMPLETED`, batal kapan pun sebelum terminal, `COMPLETED`/`CANCELLED` terminal. Transisi ilegal → `409`.

### Rate Limiting (in-memory)
- Login: 30/IP & 5/IP+email per 5 menit. Register: 10/IP per 5 menit. Chat AI: 10 per user per menit.
- Terbatas per instance proses — untuk deployment multi-instance gunakan penyimpanan bersama (Redis).

### Lapisan Lain
- **CSRF**: semua mutasi API memeriksa `Origin` vs host (`assertSameOrigin`) selain `SameSite=Lax`.
- **Validasi input** terpusat di `src/lib/validate.ts` (reject body > 32 KB, validasi per-field dengan `fields` untuk error inline).
- **Produk pernah dipesan** tidak bisa dihapus penjual → disembunyikan (`HIDDEN`) agar riwayat pesanan tetap utuh.
- **Review**: hanya pembeli dengan order `COMPLETED` yang berisi produk itu; satu ulasan per pembeli per produk (POST `409`, ubah via PATCH).
- **AI**: API key hanya dibaca dari env backend; jawaban di-grounding ke katalog DB; id produk divalidasi ulang (menghapus marker `[produk:<id>]` karangan model); pesan/history dibatasi panjangnya; input prompt injection dari user diabaikan sesuai system prompt.

## Pengujian

```bash
# Unit test (tanpa server)
npm run test

# Smoke test E2E — butuh server hidup (db:server + dev), jalankan berurutan:
npx tsx scripts/smoke-auth.mts
npx tsx scripts/smoke-marketplace.mts
npx tsx scripts/smoke-profile-ai.mts
npx tsx scripts/smoke-admin.mts
```

Setiap skrip mencetak `PASS/FAIL/SKIP` per cek dan keluar dengan kode ≠ 0 bila ada kegagalan. Smoke test memakai **user temporer** hasil register agar tidak mengganggu akun demo; hati-hati dengan rate limit login bila menjalankannya berulang cepat (reset otomatis tiap 5 menit).

Kualitas: `npm run lint` (0 problem) dan `npm run typecheck` (0 error) wajib lulus sebelum commit.

## Akun Demo

Dibuat oleh `npm run db:seed` — **hanya untuk pengembangan, ganti/hapus di produksi**:

| Email | Peran | Password |
|-------|-------|----------|
| `admin@mendungtirta.com` | ADMIN | `password123` |
| `pembeli@mendungtirta.com` | BUYER | `password123` |
| `nelayan.budi@mendungtirta.com` | SELLER | `password123` |
| `toko.pancing.jaya@mendungtirta.com` | SELLER | `password123` |

Menu dashboard: `/seller/*` (penjual), `/admin/*` (admin), `/buyer` (profil pembeli).

## Deployment

1. Siapkan PostgreSQL sungguhan (mis. managed DB) dan isi `DATABASE_URL`.
2. `npx prisma migrate deploy` lalu `npm run db:seed` (opsional — data demo).
3. `npm run build` → `npm run start` (atau deploy ke platform Node.js).
4. Setel environment: `NODE_ENV=production` (mengaktifkan cookie `secure`), `NEXT_PUBLIC_APP_URL`, dan opsional `AI_API_KEY`/`AI_BASE_URL`/`AI_MODEL`.
5. **Sebelum publik**: hapus/ganti akun demo, dan ingat rate limit berbasis memori perlu Redis bila berjalan > 1 instance.

## Keterbatasan yang Diketahui

- Pembayaran masih dummy (tanpa gateway sungguhan).
- Rate limit & sesi logout-perubahan-password bersifat per-instance (memori proses).
- Gambar produk/toko berupa URL eksternal (belum ada upload file).
- Belum ada verifikasi email/reset password (di luar cakupan tahap ini).
- Dashboard mobile: tabel data dapat digulir horizontal (sidebar menjadi tab bar).

---

Dibuat dengan [Next.js](https://nextjs.org) dan [Prisma](https://www.prisma.io).

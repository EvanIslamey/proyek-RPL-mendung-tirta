# Pemetaan Dataset Chatbot — Full Database Access & Intelligent Chatbot

Dokumen ini memetakan **seluruh dataset** yang dibaca chatbot Mendung Tirta, relasinya,
intent yang menanyakan tiap dataset, cakupan per role, agregasi/filter yang didukung,
indeks pendukung, serta daftar intent yang sudah diuji. Ground truth schema:
`prisma/schema.prisma` (PostgreSQL, Prisma ORM v7).

## 1. Arsitektur alur data

```
Pesan pengguna
   │
   ├─ Deteksi intent DETERMINISTIK (ai-intent.ts): regex + parser filter
   │    → CountKind, filter harga/kategori/toko/stok/rating/sort, ekstrem,
   │      pembeli produk, pemilik toko, peringkat toko, periode pendapatan…
   │
   ├─ Klasifikasi Gemini (opsional) HANYA untuk pemahaman — menghasilkan
   │    parameter terstruktur {priceMin, category, inStock, sortBy, …}
   │    (TIDAK PERNAH menghasilkan SQL, tidak pernah mengarang angka)
   │
   ├─ Query engine terstruktur (ai-context.ts) — Prisma + SQL parameterized
   │    (Prisma.sql / Prisma.join / Prisma.empty; tidak ada SQL bebas dari AI)
   │
   ├─ Hasil query → ContextSection / products[] → konteks AI atau
   │    jawaban langsung (jalur direct/filtered, tanpa AI)
   │
   └─ Jawaban + sources[] {label, asOf} → UI menampilkan sumber & waktu pengambilan
```

- Jawaban non-katalog (hitungan, pendapatan, pesanan, statistik, toko, akun, ulasan
  agregat) selalu `source=fallback reason=direct` — **tanpa kuota Gemini**, instan.
- Jawaban berfilter (harga/kategori/toko/stok/rating) → `reason=filtered`, deterministik.
- Gemini hanya dipakai pada jalur katalog yang tidak tercakup parser; bila provider
  gagal/tidak dikonfigurasi, fallback jujur (`provider-error`/`no-ai-config`),
  **tanpa data statis pengganti query DB**.
- Streaming SSE (`?stream=1`) memakai `planReply` yang sama → keputusan jalur dan
  jawaban identik dengan mode JSON (kontrak JSON dipertahankan).

### 1.1 Akar masalah & perbaikan (Final Database Intelligence Rebuild)

**Gejala yang dilaporkan**: "Ada produk apa saja?" dijawab "data produk tidak
ditemukan" (`products=0`, `source=ai`) padahal produk ada di DB — pertanyaan
toko/seller selalu bekerja.

**Akar masalah terbukti** (reproduksi live + skrip debug pipeline intermediat):
1. `extractSubjectPhrase` menyisakan kata sampah (`apa`, `aja`, `coba kasih lihat`)
   karena hanya memakai `SUBJECT_FILLERS` (kata tersebut ada di `STOPWORDS`,
   tidak di fillers) → subjek name-mode "apa" → pencarian nama 0 baris →
   cleanup melepas subjek → `searchCatalog([], {})` kena guard anti-dump →
   `filters={}` `products=[]` → `planReply` langkah 4 mengirim pertanyaan ke AI
   **tanpa konteks data** → Gemini mengarang "tidak ada produk".
2. **Bug precedensi SQL** (ditemukan saat uji J8): klausa OR keyword digabung
   `AND` TANPA kurung → `... AND (kw1) OR (kw2) ... AND s."storeName" ILIKE ...`
   — AND mengikat lebih kuat dari OR sehingga filter toko/harga hanya menempel
   pada keyword TERAKHIR dan produk lain lolos tanpa filter (hasil = keyword saja).

**Perbaikan**:
- `extractSubjectPhrase` ikut membuang kata `STOPWORDS` (akar masalah #1).
- Konstanta `CATALOG_LIST_INTENTS` (PRODUCT_SEARCH/PRODUCT_PRICE/PRODUCT_STOCK/
  PRODUCT_CATEGORY) + `planReply` langkah **3b**: intent katalog + `products=[]`
  + `sections=[]` → **tidak pernah** ke AI dengan konteks kosong (generik →
  `searchCatalog([], {browse:true})` + alasan statis `filtered`; spesifik →
  jawaban statis jujur `direct`).
- **Flag `ProductFilter.browse`**: telusuri katalog generik TANPA default
  `inStock` — seluruh produk `status ≠ HIDDEN` tampil (termasuk habis stok,
  label status tetap ditampilkan), sesuai aturan "jangan filter stok tanpa
  diminta user"; `inStock` tetap dipakai untuk permintaan eksplisit "tersedia".
- Kata toko (`filters.store`) ikut dibuang dari keyword pencarian — filter toko
  sudah menjadi kondisi AND ketat; sisa keyword nama toko justru menyaring
  produk berdasarkan nama/kategori PRODUK ("pancing" → kategori Alat Pancing).
- Grup klausa OR (keyword katalog & fokus produk) **dibungkus kurung** pada
  `searchCatalogRaw` & `findFocusProducts` — semua kondisi kembali bersemantik
  AND penuh.
- `skipFocus` ikut aktif untuk filter toko → pertanyaan daftar tidak jatuh ke
  jawaban fokus 1 produk; hitungan produk berfilter toko → `fetchFilteredCountSection`
  (`countCatalog`).

## 2. Peta tabel (11 model Prisma)

Kolom **tidak pernah** diekspos chatbot ditandai 🚫 (password hash, token, kredensial
terenkripsi, PII lengkap).

### 2.1 `User` — pengguna & role
- Kolom kunci: `id`, `name`, `email` unique, `password` 🚫 (bcrypt), `role`
  (ADMIN|SELLER|BUYER), `address`, `isActive`, preferensi notifikasi
  (`emailAlerts`, `telegram*`, `whatsappNotify`, `phone` 🚫 untuk chatbot),
  `createdAt`/`updatedAt`.
- Relasi: `store?` (1 seller ↔ 1 toko), `orders[]` (buyer), `reviews[]`,
  `sessions[]`, `notifications[]`.
- Indeks: `email`, `telegramChatId`, **`role`** (hitungan per-peran).
- Dibaca chatbot untuk: jumlah pengguna (total/per-role), **daftar identitas
  pengguna** (nama, role, status akun, toko untuk penjual — ADMIN saja untuk
  daftar gabungan/admin/pembeli), daftar penjual (nama + toko + status akun,
  info publik), daftar pembeli (ADMIN saja), pemilik toko (nama saja), nama
  pembeli pada ringkasan pesanan/ulasan.
- Chatbot **tidak pernah** membaca/menampilkan `password`, `phone`, `email`,
  `telegram*`, `address` (PII ditolak di semua jalur jawaban).

### 2.2 `Session` — sesi login
- `tokenHash` unique (token asli tidak disimpan), `userId`, `expiresAt`.
- Relasi: `user` (cascade). Indeks: `userId`, `expiresAt`.
- **Tidak dibaca chatbot** — hanya autentikasi.

### 2.3 `Store` — toko penjual
- Kolom kunci: `id`, `userId` unique (1:1 dengan User), `storeName`,
  `description`, `location`, `image`, `isActive`, timestamps.
- Relasi: `user` (owner), `products[]`.
- Indeks: `storeName`, **`isActive`** (katalog & jangkauan marketplace).
- Dibaca chatbot untuk: jumlah toko (semua/aktif), daftar toko (nama + pemilik +
  status), pertanyaan pemilik toko, peringkat toko (COUNT produk GROUP BY),
  ringkasan jangkauan marketplace (toko aktif — publik), toko pada daftar penjual.

### 2.4 `Category` — kategori produk
- `id`, `name` unique, `description`. Relasi: `products[]`. Indeks: `name`.
- Dibaca chatbot untuk: filter kategori ("hasil laut", "alat pancing") —
  di-resolve ke relasi `Product.category`, bukan string bebas.

### 2.5 `Product` — katalog produk
- Kolom kunci: `id`, `storeId`, `categoryId`, `name`, `description`,
  `price` Decimal(12,2), `stock`, `image`, `status`
  (AVAILABLE|OUT_OF_STOCK|HIDDEN), timestamps.
- Relasi: `store`, `category`, `orderItems[]`, `reviews[]`.
- Indeks: `storeId`, `categoryId`, `name`, **`status`**, **`price`**
  (rentang "di bawah 50000", termurah/termahal).
- Dibaca chatbot untuk: pencarian katalog (keyword + filter AND: harga
  <, >, =, antara; kategori; toko; tersedia/stok habis; rating minimal; sort),
  hitungan (total/tersedia/stok habis), ekstrem harga (MIN/MAX), stok produk
  tertentu, produk stok menipis, ringkasan katalog, peringkat toko (COUNT),
  pendapatan per produk (JOIN OrderItem), pembeli produk.

### 2.6 `Order` — pesanan
- Kolom kunci: `id`, `buyerId`, `total` Decimal(12,2), `status`
  (PENDING|PROCESSING|SHIPPED|READY_FOR_PICKUP|COMPLETED|CANCELLED),
  `shippingAddress` 🚫 (PII), timestamps (`createdAt` → filter periode).
- Relasi: `buyer` (User), `orderItems[]`, `payment?` (1:1, opsional).
- Indeks: `buyerId`, **`status`**, **`createdAt`**.
- Dibaca chatbot untuk: jumlah pesanan (total & per status, dengan sinonim
  "menunggu pembayaran"→PENDING, "selesai/diproses/dikirim"→dst.), daftar
  pesanan terbaru (milik sendiri / toko / seluruh marketplace untuk ADMIN
  tanpa rujukan "saya"), pendapatan agregat `Σ order.total` (statistik),
  laporan penjualan & aksi tertunda penjual.

### 2.7 `Payment` — pembayaran (MVP dummy)
- Kolom kunci: `id`, `orderId` unique (1 order : 1 payment), `method`,
  `amount`, `status` (PENDING|**PAID**|FAILED), `paidAt`, timestamps.
- Relasi: `order`. Indeks: **`status`**.
- Dibaca chatbot untuk: "transaksi yang berhasil" = `status=PAID`
  (CountKind `paidPayments`) — scoped peran seperti pesanan; statistik
  "Pembayaran berhasil (status PAID)" pada ringkasan admin.

### 2.8 `OrderItem` — rincian pesanan
- Kolom kunci: `id`, `orderId`, `productId`, `quantity`,
  `price` (harga saat pembelian — bisa berbeda dari harga katalog saat ini).
- Relasi: `order`, `product`. Indeks: `orderId`, `productId`.
- Dibaca chatbot untuk: **SUM(price × quantity)** = pendapatan (marketplace
  & per toko, dengan filter periode), ranking pendapatan per produk
  (GROUP BY produk ORDER BY SUM DESC), total unit terjual, pembeli suatu
  produk (GROUP BY buyer), jumlah produk per toko (COUNT).

### 2.9 `Review` — ulasan
- Kolom kunci: `id`, `productId`, `buyerId`, `rating` (1–5), `comment`,
  `createdAt`. Relasi: `product`, `buyer`.
- Unik: `(buyerId, productId)` (1 ulasan/pembeli/produk). Indeks: `productId`,
  `buyerId`.
- Dibaca chatbot untuk: jumlah ulasan (COUNT), rating rata-rata (AVG — publik,
  semua role), daftar ulasan terbaru per produk/toko (dengan nama pembeli saja),
  rating produk pada kartu katalog.

### 2.10 `Notification` — antrean notifikasi in-app/email/WA
- Kolom kunci: `userId`, `kind`, `title`, `body`, `link`, `readAt`,
  `dedupeKey`, status kirim (`emailStatus`, `waStatus`, retry, error tersanitasi).
- Relasi: `user`. Unik: `(userId, dedupeKey)`; indeks: `(userId, readAt)`,
  `(emailStatus, emailNextAt)`, `(waStatus, waNextAt)`.
- **Tidak dibaca chatbot** — hanya fitur lonceng & pengiriman notifikasi.

### 2.11 `IntegrationConfig` — kredensial integrasi (AI/WhatsApp/Telegram)
- Kolom kunci: `service`, `scope`, `provider`, `endpoint`,
  `credentialEnc` 🚫 (AES-256-GCM), `credentialHint` (tampilan aman),
  `model`, `meta` (non-rahasia), `isActive`, hasil uji koneksi.
- Unik: `(service, scope)`; indeks: `isActive`.
- **Tidak pernah dibaca/diexpos chatbot** — hanya panel Pengaturan (admin/penjual),
  kredensial terenkripsi dan tidak dikirim utuh ke frontend.

Total indeks/unik di schema: **28** (`@@index` + `@@unique`) — seluruh jalur query
chatbot (count, filter harga/status, urutan waktu, join relasi) tercakup indeks.

## 3. Relasi antar tabel

```
User (role) ──1:1── Store ──1:N── Product ──1:N── OrderItem ──N:1── Order ──1:1── Payment
   │                                │  │                              │
   │                                │  └──N:1── Category              │
   │                                │                                 │
   └──1:N── Order (buyer) ◄─────────┴─────────────────────────────────┘
   │
   └──1:N── Review ──N:1── Product
```

- `OrderItem` adalah tabel fakta untuk pendapatan (harga × qty saat transaksi).
- `Order.total` dipakai statistik ringkasan (`Σ total` pada status bisnis);
  `Σ OrderItem.price×quantity` dipakai jawaban "total pendapatan" — keduanya
  didefinisikan sama dengan `/api/admin/stats` & `/api/seller/stats`.
- `Payment.status = PAID` = "transaksi berhasil"; status order dan status
  payment TERPISAH.

## 4. Peta intent → query dataset

| Intent (ai-intent) | Fetcher / query (ai-context) | Tabel | Agregasi / filter | Scope peran |
|---|---|---|---|---|
| `USER_COUNT` (CountKind `user/seller/buyer/admin`, rincian per-role) | `fetchCountSection` + `groupBy(role)` | User | COUNT; COUNT per role | `seller` publik; `buyer/admin/user` & rincian: ADMIN |
| `USER_LIST` (target penjual/toko) | `fetchSellerListSection` | User, Store, Product (`_count`) | COUNT produk per toko; filter aktif; total penjual/toko; 20 baris + penanda | penjual & toko: publik (aktif); ADMIN: termasuk nonaktif |
| `USER_LIST` (target pengguna/admin/pembeli) | `fetchUserListSection` | User, Store | **groupBy(role)** → jumlah tiap role; baris identitas (nama, status akun, toko penjual); filter status `aktif`/`belum aktif`; pagination `halaman N` (10 baris) | ADMIN saja; non-admin: penolakan tanpa nama & tanpa angka |
| `PRODUCT_SEARCH` + filter | `searchCatalog` (SQL Prisma) | Product, Category, Store | filter AND: harga `<,>,=,antara`, kategori, toko, inStock, minRating; sort; LIMIT | katalog publik (`status ≠ HIDDEN` / `AVAILABLE`) |
| hitungan produk (`availableProducts`, `outOfStockProducts`, `totalProducts`) | `fetchCountSection` | Product | COUNT (+`stock>0`, `OUT_OF_STOCK OR stock≤0`) | publik |
| `PRODUCT_PRICE` ekstrem ("termahal **dan** termurah") | `fetchProductExtremes` | Product | MIN/MAX harga + detail | publik |
| stok produk tertentu (`PRODUCT_STOCK` + fokus) | fokus produk / `fetchProductsByIds` | Product | nilai kolom `stock` | publik |
| `ORDER_COUNT` (CountKind `orders`) | `fetchCountSection` | Order | COUNT per status; sinonim status | BUYER: milik sendiri; SELLER: pesanan berisi produk toko; ADMIN: semua (pasca "saya": semua) |
| `ORDER_COUNT` (CountKind `paidPayments`) — "transaksi berhasil" | `fetchCountSection` | Payment (JOIN Order) | COUNT `status=PAID` | scope sama seperti pesanan |
| `ORDER_STATUS` (daftar pesanan) | `fetchOrders` | Order, OrderItem, User | urutan `createdAt` DESC, batas tampilan, label status | BUYER: milik sendiri; SELLER: toko sendiri; ADMIN: milik sendiri / semua bila tanpa "saya" |
| `ORDER_STATUS` (target pembeli produk) | `fetchProductBuyers` | OrderItem, Order, User | GROUP BY buyer (100 item terakhir, top 10) | ADMIN: semua; SELLER: produk toko sendiri; BUYER: ditolak tanpa query |
| `REVENUE` (total / periode / ranking produk) | `fetchRevenue` | OrderItem, Product, Order (SQL parameterized) | `SUM(price×qty)`; filter tanggal di DB (`hari ini`…`tahun ini`); ranking `GROUP BY product ORDER BY SUM DESC LIMIT 5` | BUYER ditolak; SELLER: toko sendiri; ADMIN: marketplace |
| `SALES_REPORT` | `fetchSales` + revenue | Order, OrderItem, Store | ringkasan penjualan toko + aksi tertunda | SELLER: toko sendiri; ADMIN: marketplace |
| `MARKETPLACE_STATS` ("ringkasan marketplace") | `fetchStats` | User, Store, Product, Order, Payment, Review | groupBy status; `Σ order.total`; COUNT PAID; AVG rating; COUNT stok menipis | ADMIN; non-admin → `fetchMarketReach` (hanya data publik: toko aktif + catatan "hanya admin") |
| `STORE_INFO` (pemilik toko) | `fetchStoreOwner` | Store, User, Product | COUNT produk (+tersedia) | publik (nama pemilik saja, tanpa email/PII) |
| `STORE_INFO` (peringkat toko) | `fetchStoreRank` (SQL `COUNT(p.id) GROUP BY`) | Store, User, Product | COUNT per toko ORDER BY DESC, LIMIT 5 | publik (toko aktif) |
| `STORE_INFO` (penjual produk) | `fetchStoreInfo` → seller-of-product | Store, User | pencarian produk → toko | publik (aktif) |
| `PRODUCT_REVIEWS` / intent ulasan | `fetchReviews` | Review, User, Product | daftar terbaru; COUNT & AVG lewat hitungan | publik (rating & komentar; nama pembeli saja) |
| `ACCOUNT_INFO` | `fetchAccount` | User, Store (milik login) | data akun sendiri | sesuai pemilik akun |

Catatan penting:
- **Retensi subjek riwayat** (pre-existing): "Produk di bawah Rp50.000." setelah
  "Produk hasil laut apa saja?" memakai subjek riwayat → hasil disempitkan ke
  kategori tersebut selama filter harga masih ada (dilepas bila hasil kosong).
- Guard peringkat: pertanyaan "toko mana yang paling banyak produknya?" diarahkan
  ke peringkat (agregasi), bukan dijawab sebagai hitungan generik.

## 5. Filter & agregasi dinamis

**Operator filter**: `<`, `>`, `≤`, `≥`, `=`, rentang ("antara … sampai …"),
superlatif sort (`termurah`, `termahal`, `terbaru`, `terlama`, `tertinggi`,
`terendah`, `rating tertinggi`, `paling banyak`), sinonim bahasa
(`penjual`/`seller`, `toko`/`warung`, `habis`/`sold out`, `tersedia`/`ready`,
`berhasil`/`sukses`→PAID, `menunggu pembayaran`→PENDING, dsb.).

**Default browse (tanpa diminta user)**: pertanyaan daftar generik ("Ada produk
apa saja?", "Tampilkan semua produk.", "Jual apa aja?") memakai `browse=true`
→ TANPA filter stok/kategori/harga — seluruh produk `status ≠ HIDDEN` tampil
(termasuk habis stok, label status tetap ditampilkan). Filter stok/kategori/
harga HANYA diterapkan bila diminta user ("tersedia", "stok habis", "di bawah
Rp50.000", dst.).

**Agregasi DB (bukan dihitung AI)**:
- `COUNT` — pengguna/role, toko, produk (total/tersedia/habis), pesanan/status,
  pembayaran PAID, ulasan, unit per produk.
- `SUM` — pendapatan (`Σ price×qty`), `Σ order.total`, unit terjual.
- `AVG` — rating rata-rata ulasan.
- `MIN`/`MAX` — harga termurah/termahal.
- `GROUP BY` — pesanan per status, produk per status, pengguna per role,
  pendapatan per produk, jumlah produk per toko.
- Filter periode di level DB (`createdAt >= … AND < …`): hari ini, kemarin,
  minggu ini, bulan ini, bulan lalu, tahun ini; default "seluruh periode data".

## 6. Matriks hak akses dataset × role

| Dataset | ADMIN | SELLER | BUYER |
|---|---|---|---|
| Katalog produk (publik) | ✓ | ✓ | ✓ |
| Info toko publik (nama, pemilik, status, peringkat, produk) | ✓ | ✓ | ✓ |
| Ulasan & rating (publik) | ✓ | ✓ | ✓ |
| Jumlah penjual / toko / produk tersedia | ✓ | ✓ | ✓ |
| Jumlah pengguna total & per-role, jumlah pembeli, daftar pembeli | ✓ | ✗ (penolakan tanpa angka) | ✗ (penolakan tanpa angka) |
| Pesanan | semua (tanpa "saya") / milik sendiri | toko sendiri | milik sendiri |
| Pembeli suatu produk | ✓ semua | produk toko sendiri | ✗ ditolak tanpa query |
| Pendapatan (total/periode/ranking produk) | marketplace | toko sendiri | ✗ ditolak tanpa angka |
| Ringkasan marketplace (angka internal) | ✓ lengkap | ✗ (hanya data publik + catatan) | ✗ (sama) |
| Password / API key / token / PII (email, telepon, alamat) | 🚫 tidak pernah ditampilkan — untuk semua role |

## 7. Performa & keamanan query

- **Query hanya tabel relevan** per intent; hitungan sederhana dihitung DB
  (`count`/`groupBy`/`aggregate`/SQL `SUM`) — bukan oleh AI.
- **Batas tampilan**: daftar produk terfilter ditampilkan maks. 5 baris
  (dengan jumlah total "Menampilkan N produk yang cocok"), peringkat toko 5,
  ranking pendapatan 5, pembeli produk top 10 dari 100 item terakhir,
  ulasan terbaru terbatas, jawaban non-katalog dipotong 1800 karakter.
- **Anti N+1**: `findMany` dengan `select/include`, `groupBy`, `aggregate`,
  atau SQL agregasi tunggal — tidak ada query per baris.
- **Cache** ringan untuk hitungan & statistik (`cached()`, TTL pendek) — angka
  tetap diambil dari DB, bukan statis.
- **SQL injection aman**: seluruh SQL mentah memakai `Prisma.sql`/
  `Prisma.join`/`Prisma.empty` (parameterized). AI tidak pernah menulis SQL —
  hanya parameter terstruktur yang di-merge deterministik.
- **Indeks DB lengkap** (28) mendukung seluruh jalur: `Product.price/status`,
  `Order.status/createdAt/buyerId`, `Payment.status`, `User.role`,
  `Store.isActive`, `Review.productId`, `OrderItem.orderId/productId`.
- **Rate limit** chat 10 pesan/60 detik per akun (uji live memakai scheduler
  global 2,6 dtk + jarak minimum 7 dtk per akun).

## 8. Intent yang teruji (bukti pengujian)

### 8.1 Uji live `scripts/test-chatbot-db-queries.mts` — 974 pemeriksaan, 0 gagal
Setiap jawaban dibandingkan dengan **ground truth query DB langsung** (Prisma/SQL),
3 peran login (ADMIN/SELLER/BUYER), 84 pesan terpacing.

> Angka pada tabel di bawah adalah **snapshot DB demo** saat dokumen diperbarui
> (15 Nov 2026, katalog 14 produk). Skrip selalu menghitung ulang ground truth
> dari DB aktif, jadi angka bisa berubah bila data seed/transaksi berubah.

**13 kategori wajib** (K1–K14):

| # | Kategori | Pertanyaan contoh | Verifikasi |
|---|---|---|---|
| K1 | Jumlah pengguna per role | "Tampilkan jumlah pengguna setiap role." | ADMIN: rincian A1/S2/B9 + total 12; non-admin: penolakan tanpa angka |
| K2 | Daftar seller | "Siapa saja seller?" | header `Daftar penjual (2)` + nama + toko + status akun + jumlah produk |
| K3 | Daftar toko | "Tampilkan semua nama toko." | `Daftar toko (2)` + pemilik tiap toko |
| K4 | Produk per kategori | "Produk hasil laut apa saja?" | maks 5 kartu (GT 8); semua berkategori Hasil Laut, kartu nama+harga+stok+kategori+toko, balasan "Menampilkan 5 dari 8 produk" |
| K5 | Harga bawah | "Produk di bawah Rp50.000." | `filtered`, jumlah = GT (4), semua harga < 50.000 |
| K6 | Harga atas | "Produk di atas Rp50.000." | `filtered`, maks 5 kartu (GT 10), semua harga > 50.000, balasan "Menampilkan 5 dari 10 produk" |
| K7 | Stok produk tertentu | "Berapa stok ikan kerapu?" | angka stok = GT (15) + merujuk produk |
| K8 | Stok habis | "Berapa jumlah produk yang stoknya habis?" | GT 0 → jawaban jujur "Tidak ada produk dengan stok habis" |
| K9 | Pesanan per status | "…menunggu pembayaran?" / "…selesai?" | PENDING: A2/S1/B1; COMPLETED: A3/S3/B3 (scoped peran) |
| K10 | Total pendapatan | "Berapa total pendapatan?" | ADMIN = GT Σ(price×qty) status bisnis (snapshot Rp1.795.000), SELLER discoping tokonya, BUYER ditolak tanpa Rp |
| K11 | Statistik ulasan | "Berapa jumlah ulasan?" / "…rating rata-rata?" | COUNT/AVG Review = GT (snapshot 3 ulasan, rata-rata 4.3) — semua role |
| K12 | Bahasa tidak baku/sinonim | "Toko ada berapa sih?" / "Berapa sih total seller…?" | 2 toko / 2 penjual (GT) |
| K13 | Pertanyaan lanjutan kontekstual | "Ada ikan kerapu?" → "Berapa stoknya?" | dijawab dari riwayat: kerapu, stok 15 |
| K14 | Akses data tak diizinkan | "Berapa jumlah pengguna?" / "…pembeli?" | non-admin: penolakan tanpa angka & tanpa nama; ADMIN: 12 / 9 |

**8 kasus domain baru** (B1–B8):

| # | Kasus | Pertanyaan contoh | Verifikasi |
|---|---|---|---|
| B1 | Pemilik toko | "Siapa pemilik toko Hasil Laut Pak Budi?" | `Budi Santoso` + jumlah produk + status, tanpa email |
| B2 | Peringkat toko | "Toko mana yang memiliki produk terbanyak?" | SQL COUNT GROUP BY: 1. Hasil Laut Pak Budi — 8 produk; 2. Pancing Jaya Abadi — 6 produk |
| B3 | Ekstrem harga | "Produk termahal dan termurah apa?" | MIN Rp18.000 (Kail Pancing No. 5) & MAX Rp240.000 (Lobster Segar) + stok/kategori/toko |
| B4 | Pembeli produk | "Siapa pembeli yang memesan ikan kerapu?" | ADMIN/SELLER: nama pembeli + total unit + id pesanan; BUYER: ditolak, nama tidak bocor |
| B5 | Transaksi berhasil | "Berapa transaksi yang berhasil?" | PAID = GT COUNT (snapshot 12), discoping per peran |
| B6 | Pendapatan bulan ini | "Berapa pendapatan bulan ini?" | Σ price×qty pada rentang tanggal di DB, discoping peran; BUYER ditolak |
| B7 | Pendapatan per produk | "…pendapatan terbesar?" | ranking SUM(price×qty) GROUP BY produk, discoping peran |
| B8 | Ringkasan marketplace | "Tampilkan ringkasan marketplace." | ADMIN: baris angka GT (user/toko/produk/pesanan/pendapatan/PAID/ulasan); non-admin: data publik + catatan hanya-admin |

Setiap jawaban juga diperiksa: HTTP 200, `source` valid, **sumber + waktu
pengambilan terisi** (`sources[].label/asOf`), tanpa kartu produk pada jawaban
hitungan, dan **tanpa email/PII**.

### 8.2 Unit test — 420 lulus (13 file)
- `ai-intent.test.ts` (91): deteksi CountKind baru (paidPayments/reviews/avgRating),
  guard peringkat, pemilik toko, ekstrem harga (fix "terendah"), pembeli produk,
  periode pendapatan, **daftar identitas pengguna** ("siapa saja pengguna/admin/
  penjual/pembeli/penggunanya", filter status, "berdasarkan role" → `USER_LIST`;
  "siapa pemilik toko X" tetap `STORE_INFO`; "ada berapa pengguna dan siapa
  namanya" → `USER_COUNT` + daftar).
- `ai-context.test.ts` (77): queryCountData kind baru + scope peran,
  formatCountAnswer (termasuk null-case jujur), fetchStoreOwner/fetchStoreRank/
  fetchProductExtremes/fetchProductBuyers/fetchRevenue periode & ranking,
  cabang ADMIN marketplace pada fetchOrders, **fetchUserListSection** (kelompok
  ADMIN/SELLER/BUYER + jumlah per role, filter status, pagination jujur,
  data kosong, error groupBy), total penjual.
- `ai-routing.test.ts` (4, BARU): `planReply` langkah 3b — intent katalog tanpa
  hasil tidak pernah ke AI dengan konteks kosong (browse generik → statis
  `filtered`; keyword spesifik → statis `direct`).
- `ai.test.ts` (119, +1): `extractSubjectPhrase` membuang kata sampah STOPWORDS
  ("apa", "aja", "coba kasih lihat") — regresi akar masalah "Ada produk apa saja?".
- Sisanya: filter/parse, route, komponen (regresi lama tetap lulus).

### 8.3 Uji cakupan dataset (requirement J) — 169 pemeriksaan, 0 gagal
`scripts/test-chatbot-dataset.mts` — **15 pertanyaan wajib × audit lengkap**
(setiap baris mencatat: pertanyaan → intent terdeteksi pipeline → jumlah baris
GT dari query DB langsung → jawaban chatbot → perbandingan angka/daftar; bukan
sekadar HTTP 200) + 2 spot-check hak akses:

| # | Pertanyaan | Intent | GT (query DB langsung) | Jawaban chatbot |
|---|---|---|---|---|
| J1 | Ada produk apa saja? | PRODUCT_SEARCH | produk visible = 14 | 5 kartu + "Menampilkan 5 dari 14 produk", `filtered`, tanpa klaim kosong |
| J2 | Berapa total produk? | PRODUCT_SEARCH | totalProducts (visible) = 14 | "Saat ini terdapat 14 produk terdaftar" |
| J3 | Tampilkan semua produk. | PRODUCT_SEARCH | produk visible = 14 | 5 kartu + keterangan "5 dari 14", `filtered` |
| J4 | Produk hasil laut apa saja? | PRODUCT_SEARCH | kategori "Hasil Laut" = 8 | 5 kartu + "Menampilkan 5 dari 8 produk" |
| J5 | Produk di bawah Rp50.000. | PRODUCT_SEARCH | harga < 50.000 = 4 | 4 produk cocok persis |
| J6 | Produk di atas Rp50.000. | PRODUCT_SEARCH | harga > 50.000 = 10 | 5 kartu + "Menampilkan 5 dari 10 produk" |
| J7 | Produk yang stoknya habis apa saja? | PRODUCT_STOCK | stok habis = 0 | jujur "tidak ada", tanpa produk |
| J8 | Produk dari toko Pancing Jaya Abadi. | PRODUCT_SEARCH | toko = 6 | 5 kartu + "Menampilkan 5 dari 6 produk" (setelah fix precedensi SQL) |
| J9 | Siapa saja seller? | USER_LIST | seller = 2 | `Daftar penjual (2)` + nama tiap penjual |
| J10 | Berapa jumlah pengguna setiap role? | USER_COUNT | A1/S2/B9, total 12 | rincian Admin/Penjual/Pembeli + Total 12 |
| J11 | Berapa jumlah toko aktif? | STORE_INFO | toko aktif = 2 | "Saat ini terdapat 2 toko aktif" |
| J12 | Berapa total pesanan? | ORDER_COUNT | pesanan (semua) = 19 | "Terdapat 19 pesanan di marketplace" |
| J13 | Berapa total pendapatan? | REVENUE | SQL Σ total order status bisnis = Rp1.795.000 | "Total pendapatan marketplace adalah Rp1.795.000" |
| J14 | Berapa jumlah ulasan? | PRODUCT_SEARCH | COUNT Review = 3 | "Saat ini terdapat 3 ulasan di Mendung Tirta" |
| J15 | Tampilkan ringkasan marketplace. | MARKETPLACE_STATS | pengguna 12, toko 2 (aktif 2), pendapatan Rp1.795.000, PAID 12, ulasan 3 | baris angka GT identik |
| R1 | SELLER: "Ada produk apa saja?" | PRODUCT_SEARCH | katalog publik = 14 | 5 kartu + "Menampilkan 5 dari 14 produk" (sama dengan GT publik) |
| R2 | BUYER: "Berapa total pesanan?" | ORDER_COUNT | pesanan milik sendiri = 10 (global 19) | "Anda memiliki 10 pesanan", angka global TIDAK bocor |

### 8.4 Regresi skrip lama (wajib lulus)
- `test-chatbot-seller-list.mts` (309 pemeriksaan), `test-chatbot-roles.mts` (262),
  `test-chatbot-suite.mts` (94), `smoke-integrations.mts` (66),
  `test-chatbot-intents.mts` (294), `test-chatbot-db-queries.mts` (974),
  `test-chatbot-dataset.mts` (169), `verify-db-ai-config.mts` (9) — dijalankan
  berurutan dengan jeda rate-limit; `typecheck` (tsc), `lint` (eslint), dan
  `npm run build` lulus tanpa error.
- **Hasil terakhir (14 Nov 2026)**: 309 + 262 + 94 + 66 + 294 + 962 + 169 + 9 =
  **2.165 pemeriksaan, 0 gagal**; unit `vitest` **420/420** (13 file);
  `tsc --noEmit` & `eslint` exit 0; `npm run build` sukses (semua route
  `/api/settings/*/test|toggle` ikut ter-build).
- **Verifikasi ulang setelah redesign UI + katalog 14 produk (15 Nov 2026)**:
  `smoke-marketplace` 40/40, `test-chatbot-dataset` 169/169,
  `test-chatbot-db-queries` 974/974, `test-chatbot-seller-list` 309/309,
  unit `vitest` 420/420, `tsc --noEmit` & `eslint` exit 0, `npm run build` sukses.
  Tidak ada perubahan logika chatbot pada redesign ini.

### 8.5 Uji identitas pengguna (nama dari DB) — `test-chatbot-user-identity.mts`
330 pemeriksaan, 0 gagal. Ground truth = query Prisma langsung ke DB aktif
(`User` + relasi `Store`), dibandingkan per nama/per angka — bukan hanya HTTP 200.

| # | Uji wajib | Pertanyaan | Verifikasi (GT DB) |
|---|---|---|---|
| 1 | Semua pengguna | "Tampilkan semua pengguna." | ringkasan `Total pengguna: 12 — ADMIN: 1, SELLER (Penjual): 2, BUYER (Pembeli): 9`; kelompok `ADMIN (1):`/`SELLER (2):`/`BUYER (9):`; 10 nama halaman 1 + penanda `Halaman 1 dari 2` |
| 1b | Paginasi riwayat | "halaman 2" (setelah daftar) | `Halaman 2 dari 2` + sisa nama — gabungan halaman 1+2 = SELURUH 12 nama DB |
| 2 | Daftar admin | "Siapa saja admin?" | `Daftar admin (1 akun)` + `Evan Islamey y j` + `Total admin: 1.` |
| 3 | Daftar penjual + toko | "Siapa saja seller atau penjual?" | `Daftar penjual (2)` + tiap nama + `Toko: … (Aktif)` + `Total penjual: 2.` |
| 4 | Daftar pembeli | "Siapa saja buyer atau pembeli?" | `Daftar pembeli (9 akun)` + 9 nama + `Total pembeli: 9.` |
| 5 | Jumlah ↔ daftar cocok | "Ada berapa pengguna dan siapa namanya?" | `terdapat 12 pengguna terdaftar` + `Total pengguna: 12` + nama halaman 1 (angka == daftar) |
| 6 | Variasi kalimat | "Siapa saja pengguna Mendung Tirta?", "Siapa nama seluruh penjual?", "Siapa saja pengguna yang aktif?", "…belum aktif?", "Tampilkan daftar pengguna berdasarkan role.", "Sebutkan nama penjual beserta nama tokonya." | kelompok/nama/toko identik GT; status nonaktif tidak ikut daftar aktif (GT: 12 aktif, 0 belum aktif → jawaban jujur "belum ada") |
| 7 | Relasi User–Store | "Siapa pemilik toko Pancing Jaya Abadi?" | nama pemilik (`Toko Pancing Jaya`) + nama toko (`Pancing Jaya Abadi`) + status toko/akun + jumlah produk — nama pengguna & nama toko dibedakan |
| A | Hak akses SELLER/BUYER | "Siapa saja pengguna?", "Siapa saja buyer?" | penolakan `hanya dapat dilihat oleh admin`, TANPA angka & TANPA nama bocor |
| B | Info publik tetap boleh | "Siapa saja seller?" (non-admin) | penjual/toko AKTIF saja (GT filter) — nama tampil |

Setiap jawaban juga diperiksa: HTTP 200, `source=fallback reason=direct`,
tanpa kartu/Rp produk, tanpa email/`Email:`/password/token/API key.

## 9. Batasan yang diketahui

- **Cap tampilan** (bukan paginasi penuh): daftar terfilter maks. 5 baris;
  jawaban non-katalog maks. 1800 karakter. Untuk data lengkap, arahkan ke
  halaman dashboard terkait.
- **Daftar identitas pengguna dipaginasi 10 baris/halaman** (agar tidak
  terpotong batas panjang jawaban). Balasan selalu menyebut
  `Halaman X dari Y — menampilkan pengguna ke-A–B dari N`; "halaman N"
  berikutnya disambungkan ke permintaan daftar terakhir pada riwayat sesi.
  Daftar gabungan/admin/pembeli khusus ADMIN — SELLER/BUYER menerima
  penolakan tanpa nama & tanpa angka; daftar penjual/toko tetap publik
  (hanya akun/toko aktif).
- **Catatan operasional (dev, Turbopack)**: setelah dev server berjalan sangat
  lama / setelah build produksi di direktori yang sama, registry route Turbopack
  bisa basi — ditandai endpoint bersarang (mis. `/api/settings/whatsapp/test`,
  `/api/settings/api-key/toggle`) menjawab 404 padahal handler-nya ada. Solusi:
  restart `npm run dev` (terbukti 404 → 401/200 tanpa perubahan kode).
- **Streaming**: mode SSE tersedia dan memakai `planReply` yang sama sehingga
  jawaban identik dengan mode JSON (kontrak JSON dipertahankan).
- **Retensi subjek riwayat** dapat menyempitkan pertanyaan filter berikutnya
  (perilaku lama yang disengaja) — pertanyaan mandiri tanpa riwayat menjawab
  seluruh data yang cocok.
- **Kuota Gemini** hanya untuk jalur katalog non-deterministik; seluruh jawaban
  data (hitungan, statistik, pendapatan, pesanan, toko) tidak memakai AI.

/**
 * Klasifikasi maksud (intent) chatbot — deteksi DETERMINISTIK + penyempurnaan
 * GEMINI (Bahasa Indonesia, sinonim, konteks percakapan).
 *
 * Dua lapis, berurutan:
 * 1. `detectChatbotIntent(message)` — murni tanpa jaringan/DB, bisa diuji
 *    unit. Mengklasifikasi pesan ke taksonomi CHATBOT_INTENTS (di
 *    ./ai) dengan prioritas: sapaan → layanan → role/hak akses → hitungan
 *    per entitas → akun → laporan/pendapatan → statistik → pesanan → toko →
 *    produk → umum.
 * 2. `classifyChatbotIntent(message, history)` — bila deteksi deterministik
 *    TIDAK yakin (GENERAL) DAN pesan mengandung sinyal data, tanyakan Gemini
 *    (generateContent, JSON ketat, timeout pendek) untuk memahami bahasa
 *    alami/sinonim/konteks. Segala kegagalan → hasil deterministik (tidak
 *    pernah melempar, tidak pernah menampilkan key).
 *
 * Modul ini juga memuat deteksi level fetcher (`detectIntents`,
 * `detectCountQuery`) yang menentukan query database mana yang boleh
 * berjalan — dipakai buildChatContext dan di-re-export oleh ./ai-context.
 *
 * Tidak ada siklus dependensi: ai-intent → ai (helper) → (type-only) →
 * ai-context → ai-intent.
 */

import {
  parsePriceFilter,
  extractSubjectPhrase,
  isGreetingMessage,
  geminiUrl,
  geminiBody,
  geminiText,
  CHATBOT_INTENTS,
  type ChatbotIntent,
  type IntentParams,
  type ProductFilter,
} from "./ai";
import { resolveAiRuntime, type AiRuntime } from "./integrations";
import { cached } from "./ai-cache";

/* ------------------------------------------------------------------ */
/* Kategori intent fetcher (pindahan dari ai-context — SATU sumber)    */
/* ------------------------------------------------------------------ */

export type ChatIntent =
  | "product"
  | "order"
  | "sales"
  | "stats"
  | "count" // pertanyaan hitungan per entitas (jumlah penjual/pembeli/…) — prioritas atas "stats"
  | "lowstock"
  | "outofstock"
  | "store"
  | "account"
  | "reviews"
  | "appinfo";

/** Jenis hitungan tunggal yang ditanyakan user (spesifik > ringkasan umum). */
export type CountKind =
  | "seller" // akun penjual (role SELLER)
  | "buyer"
  | "admin"
  | "user" // seluruh pengguna/akun
  | "store" // toko terdaftar (tabel Store — bukan akun penjual)
  | "totalProducts"
  | "availableProducts"
  | "outOfStockProducts"
  | "orders"
  | "paidPayments" // pembayaran berhasil (tabel Payment, status PAID)
  | "reviews" // jumlah ulasan (tabel Review — data publik)
  | "avgRating"; // rating rata-rata seluruh ulasan (AVG)

/**
 * Deteksi pertanyaan HITUNGAN tunggal — SATU-SATUNYA tempat pola bahasa
 * hitungan didefinisikan (dipakai detectIntents & buildChatContext — tidak
 * ada aturan duplikat yang bisa saling bertentangan).
 *
 * Murni (tanpa DB/AI), menangani variasi bahasa Indonesia:
 * "berapa jumlah penjual?", "ada berapa penjual?", "jumlah seller berapa?",
 * "berapa seller yang terdaftar?", dst. "Ada berapa toko terdaftar?" diarahkan
 * ke hitungan TOKO (tabel Store) — bukan akun penjual — sesuai skema database.
 *
 * Return: daftar jenis hitungan (bisa >1 bila user menanyakan beberapa
 * entitas dalam satu pertanyaan); kosong bila bukan pertanyaan hitungan.
 */
export function detectCountQuery(message: string): CountKind[] {
  const m = message.toLowerCase().replace(/[^\w\s-]/g, " ");
  // Penanda pertanyaan hitungan — tanpa ini BUKAN pertanyaan jumlah.
  const asksCount = /\bberapa\b|\bseberapa\b|\bjumlah\b|\bbanyak\b|\bsebanyak\b|\btotal\b/.test(m);
  if (!asksCount) return [];

  // Pertanyaan PERINGKAT/KEPEMILIKAN ("toko mana yang paling banyak produk?")
  // mengandung "banyak" tapi bukan pertanyaan angka — dijawab peringkat toko
  // (fetchStoreRank), bukan hitungan total.
  if (
    STORE_RANK_RE.test(m) ||
    /\b(?:mana|yang mana|siapa)\b[^.!?]{0,40}\b(?:paling\s+banyak|terbanyak)\b/.test(m)
  ) {
    return [];
  }

  // Hitungan GLOBAL tidak berlaku untuk pertanyaan milik sendiri
  // ("berapa akun saya?" → profil akun, bukan total pengguna platform).
  const personal = /\bsaya\b|\baku\b|\bsendiri\b/.test(m);
  // "apa saja/daftar/sebutkan" = minta DAFTAR, bukan angka.
  const wantsList = /\bapa saja\b|\bdaftar\b|\bsebutkan\b|\bmana saja\b|\bsebut\b/.test(m);
  const kinds = new Set<CountKind>();

  if (!personal) {
    // \bpenjual\b tidak cocok dengan "penjualan" (pertanyaan omzet → intent sales).
    if (/\bpenjual(?:nya)?\b|\bsellers?\b/.test(m)) kinds.add("seller");
    if (/\bpembeli(?:nya)?\b|\bbuyers?\b/.test(m)) kinds.add("buyer");
    if (/\badmins?\b|\badministrator\b/.test(m)) kinds.add("admin");
    if (/\bpengguna\b|\busers?\b|\baccounts?\b|\bakun\b/.test(m)) kinds.add("user");
    if (/\btoko(?:nya)?\b|\bstores?\b/.test(m)) kinds.add("store");
  }

  // Hitungan produk — hanya bila bukan minta daftar/atribut satu produk.
  const productEntity = /\bproduk(?:nya)?\b|\bbarang\b|\bitem\b/.test(m);
  const singleProductAttr = /\bulasan\b|\breviews?\b|\brating\b|\bharga\b|\bkomentar\b|\bmenipis\b|hampir habis/.test(m);
  if (productEntity && !wantsList && !singleProductAttr) {
    const oos = /\bhabis\b|out of stock|sold out|\btidak tersedia\b|\bkosong\b/.test(m);
    const avail = (/\btersedia\b|\bready\b|\bavailable\b|ada untuk dibeli/.test(m) && !/\btidak tersedia\b/.test(m));
    if (avail && !oos) kinds.add("availableProducts");
    else if (oos) kinds.add("outOfStockProducts");
    else kinds.add("totalProducts");
  }

  // Pembayaran BERHASIL ("berapa transaksi berhasil?") → tabel Payment (PAID).
  // Negasi (belum/gagal/menunggu) TIDAK dihitung berhasil — tetap pesanan biasa.
  const payWord = /\b(?:transaksi|pembayaran|payment)\b/.test(m);
  const payOk = /\b(?:berhasil|sukses|successful)\b/.test(m);
  const payNegated =
    /\bbelum\b|\btidak\b|\bgagal\b|\bmenunggu\b|\bbatal\b|\bpending\b/.test(m);
  if (payWord && payOk && !payNegated) {
    kinds.add("paidPayments");
  } else if (/\bpesanan\b|\borders?\b|\btransaksi\b/.test(m)) {
    // Pesanan — cakupan mengikuti peran (milik sendiri/toko/marketplace).
    kinds.add("orders");
  }

  // Ulasan & rating — data publik katalog (tabel Review). Superlatif
  // ("rating tertinggi") bukan pertanyaan rata-rata → serahkan ke daftar/urutan.
  const wantsAvg =
    /\b(?:rating|bintang)\b/.test(m) &&
    !/\b(?:tertinggi|terendah|terbaik|terburuk|paling|terbesar|terkecil|terlaris|pertama)\b/.test(m);
  if (!wantsList) {
    if (/\b(?:ulasan|reviews?|penilaian|komentar)\b/.test(m)) kinds.add("reviews");
    if (wantsAvg) kinds.add("avgRating");
  }

  // Urutan deterministik (untuk format jawaban bila >1).
  const order: CountKind[] = [
    "seller", "buyer", "admin", "user", "store",
    "totalProducts", "availableProducts", "outOfStockProducts",
    "orders", "paidPayments", "reviews", "avgRating",
  ];
  return order.filter((k) => kinds.has(k));
}

/**
 * Deteksi jenis fetcher (murni, tanpa AI — bisa diuji unit test).
 * Hanya menentukan FETCHER mana yang boleh dijalankan; otorisasi tetap
 * diputuskan per peran di `buildChatContext`.
 */
export function detectIntents(message: string): Set<ChatIntent> {
  const m = message.toLowerCase();
  const has = (...words: string[]) => words.some((w) => m.includes(w));
  const intents = new Set<ChatIntent>();

  // A. Produk / katalog (harga, ketersediaan, kategori, rekomendasi…)
  if (
    has(
      "harga", "produk", "katalog", "tersedia", "stok", "kategori", "beli",
      "rekomendasi", "murah", "mahal", "ready", "varian", "ukuran",
      "diskon", "restock", "masih ada", "ada nggak",
      "ada gak", "mau cari", "cari", "dijual", "apa saja", "ada apa",
      "apa aja", "barang", "item", "tampilkan", "tampilin", "tunjukkan",
      "lihat produk", "daftar produk", "semua produk", "produk apa",
      "jual apa", "ada produk", "yang dijual",
    )
  ) {
    intents.add("product");
  }
  // Filter harga/frasa kriteria ("di bawah 50000", "di atas 50000") juga
  // merupakan pertanyaan berbasis produk — jangan jatuh ke intent lain.
  if (parsePriceFilter(message)) {
    intents.add("product");
  }
  // Reviews/ulasan
  if (has("ulasan", "review", "rating", "komentar", "penilaian", "bintang")) {
    intents.add("product");
    intents.add("reviews");
  }
  // B. Pesanan
  if (has("pesanan", "pembelian", "order", "checkout", "bayar", "dibayar", "dikirim")) {
    intents.add("order");
  }
  // Penjualan (penjual)
  if (has("penjualan", "omzet", "pendapatan", "revenue", "terjual", "penghasilan", "laku")) {
    intents.add("sales");
  }
  // Statistik marketplace (ringkasan UMUM — hanya bila user meminta rekap/
  // statistik; pertanyaan hitungan per entitas masuk intent "count", BUKAN sini)
  if (
    has(
      "statistik", "statistic", "rekap", "performa platform",
      "performa marketplace", "ringkasan statistik",
      "ringkasan marketplace", "ringkasan seluruh", "ringkasan platform",
      "ringkasan aplikasi", "ringkasan data", "seluruh marketplace",
    )
  ) {
    intents.add("stats");
  }
  // Stok menipis vs stok habis — "hampir habis" bukan habis.
  const wantsLowStock = has("stok menipis", "hampir habis", "stok tersisa", "stok sedikit", "menipis");
  if (wantsLowStock) {
    intents.add("lowstock");
  }
  const withoutNearly = m.replace(/hampir habis/g, " ");
  if (/(^|[^a-z])habis|out of stock|sold out|stok 0|kehabisan/.test(withoutNearly)) {
    intents.add("outofstock");
  }
  // Toko / penjual (profil toko publik)
  if (has("toko", "penjual", "seller", "penjualnya", "tokonya", "siapa yang jual")) {
    intents.add("store");
  }
  // C. Akun sendiri
  if (
    has(
      "siapa saya", "akun saya", "profil saya", "informasi akun", "nama saya", "email saya",
      "login sebagai", "kapan daftar", "bergabung sejak", "role saya", "peran saya",
      "ubah profil", "ganti profil", "edit profil", "akun apa", "profil apa",
      "daftar kapan", "sejak kapan", "peran apa", "role apa",
      "alamat saya", "ganti nama", "ganti alamat", "ubah alamat", "ubah nama",
      // kata kunci individual untuk menangkap variasi
      "daftar", "sejak", "peran", "role", "akun", "profil", "email", "password", "sandi", "kata sandi"
    )
  ) {
    intents.add("account");
  }
  // E. Informasi aplikasi (layanan, tentang kami, panduan)
  if (
    has(
      "layanan", "tentang kami", "apa itu mendung", "siapa mendung", "tentang mendung",
      "cara belanja", "cara beli", "cara pesan", "cara daftar", "cara mendaftar",
      "cara checkout", "cara bayar", "gimana cara", "bagaimana cara", "cara menggunakan",
      "panduan", "bantuan", "faq", "fitur apa", "layanan apa", "bisa apa",
      // aturan/ketentuan penggunaan ("Apa aturan penggunaan Mendung Tirta?")
      "aturan", "ketentuan", "kebijakan",
    )
  ) {
    intents.add("appinfo");
  }
  // Pertanyaan hitungan per entitas ("berapa jumlah penjual?" dst.) —
  // prioritas di atas ringkasan statistik umum (lihat detectCountQuery).
  if (detectCountQuery(message).length > 0) {
    intents.add("count");
  }
  return intents;
}

/* ------------------------------------------------------------------ */
/* Klasifikasi taksonomi utama (lapis deterministik)                    */
/* ------------------------------------------------------------------ */

export type IntentDetection = {
  intent: ChatbotIntent;
  /** "high" = aturan bahasa cocok tegas (langsung dipakai);
   *  "low" = tidak ada aturan yang cocok → berpeluang disempurnakan Gemini. */
  confidence: "high" | "low";
  source: "deterministic" | "gemini";
  /** Parameter pencarian terstruktur (hanya bila disempurnakan Gemini). */
  params?: IntentParams;
};

/** Frasa pendapatan (sinonim Indonesia + istilah bisnis umum). */
const REVENUE_RE =
  /\b(?:pendapatan|pemasukan|omzet|omset|revenue|penghasilan|cuan|income|uang\s+masuk|hasil\s+jualan)\b/;

/** Frasa laporan/rekap penjualan (bukan sekadar angka pendapatan). */
const SALES_REPORT_RE =
  /\b(?:laporan|rekap)\b|\bterlaris\b|\bpenjualan\b|\bterjual\b|\bomzet\b[^.]{0,40}\b(?:bulan|minggu|tahun|periode|kemarin)\b|\b(?:performa|kinerja|hasil)\s+(?:toko|jualan|usaha|penjualan|pendapatan)\b/;

/** Pertanyaan profil/kepemilikan toko — hati-hati: "jual" ada di "penjual". */
const STORE_INFO_RE =
  /(?:siapa\s+(?:yang\s+)?(?:menjual|penjual|seller)|penjual(?:nya)?\s+(?:siapa|mana)|profil\s+toko|info(?:rmasi)?\s+toko|tentang\s+toko|lokasi\s+toko|toko\s+(?:siapa|milik\s+siapa)|(?:di\s+)?mana\s+(?:lokasi\s+)?(?:toko|penjual|sellernya)|(?:siapa(?:\s+saja)?\s+(?:yang\s+)?(?:pemilik(?:nya)?|punya|owner)|(?:pemilik|punya)\s+(?:toko|store)))/;

/** "Toko mana yang memiliki produk terbanyak?" → peringkat toko (STORE_INFO). */
export const STORE_RANK_RE =
  /(?:\btoko\b|\bstore\b)[^.!?]{0,60}\b(?:terbanyak|paling\s+banyak)\b|\b(?:mana|siapa)\b[^.!?]{0,30}\bproduk(?:nya)?\s+(?:paling\s+)?(?:banyak|terbanyak)\b/;

/**
 * "Siapa pembeli yang memesan ikan kerapu?" / "Siapa yang membeli produk X?" —
 * pertanyaan PEMBELI per produk (tabel Order/OrderItem, cakupan per peran)
 * → diarahkan ke intent pesanan (ORDER_STATUS) + fetcher khusus pembeli produk.
 */
const BUYERS_OF_PRODUCT_RE =
  /\bsiapa\b[^.!?]{0,60}\b(?:pembeli|buyer|konsumen|customer)\b[^.!?]{0,70}\b(?:memesan|membeli|dipesan|dibeli|beli(?:kan)?)\b|\bsiapa\b[^.!?]{0,50}\b(?:pembeli|buyer)\b[^.!?]{0,60}\b(?:produk|barang|dari|untuk)\b|\bsiapa\s+yang\s+(?:memesan|membeli|beli)\b/;

/** True bila pesan menanyakan pembeli dari suatu produk (murni, tanpa jaringan). */
export function detectBuyersOfProduct(message: string): boolean {
  return BUYERS_OF_PRODUCT_RE.test(message.toLowerCase());
}

/**
 * "Produk paling mahal dan paling murah?" → MIN/MAX harga aktual (agregasi).
 * Hanya dipasang bila KEDUA ekstrem disebut — "Produk termurah." tetap
 * memakai jalur urutan/filter yang sudah ada (regresi lama dipertahankan).
 */
export function detectProductExtremes(message: string): boolean {
  const m = message.toLowerCase();
  if (!/\b(?:produk|barang|item|harga)\b/.test(m)) return false;
  const high = /\b(?:paling\s+|ter)?(?:mahal|tinggi)\b/.test(m);
  // "terendah" = "te"+"rendah" (bukan "ter"+"rendah") → tangkap eksplisit.
  const low = /\b(?:paling\s+|ter)?(?:murah|rendah)\b/.test(m) || /\bterendah\b/.test(m);
  return high && low;
}

const REVIEW_RE = /\bulasan\b|\breviews?\b|\brating\b|\bkomentar\b|\bpenilaian\b/;

/** Penanda konteks produk bila frasa subjek terdeteksi ("Ada ikan kerapu?" →
 *  produk; "berapa duit masuk minggu ini" → bukan, tetap umum). */
const PRODUCT_CONTEXT_RE =
  /\b(?:ada|punya|mau|beli|beliin|cari|carikan|nyari|ingin|butuh|butuhkan|jual|dijual|tampilkan|tampilin|tunjukkan|lihat|daftar|rekomendasi|stok|harga|produk|barang)\b/;

/** Sinyal bahwa pesan mungkin menanyakan DATA (meski sinonimnya tak dikenal)
 *  — penanda untuk mencoba penyempurnaan klasifikasi via Gemini. */
const DATA_SIGNAL_RE =
  /\bberapa|jumlah|total|harga|stok|pesanan|pendapatan|omzet|penjualan|terjual|statistik|rekap|laporan|ringkasan|performa|produk|kategori|toko|penjual|pembeli|pengguna|akun|profil|layanan|tersedia|belanja|keranjang|checkout|ulasan|review|rating|pengiriman|alamat|password|pemilik|marketplace|sandi\b/i;

/** True bila `v` termasuk salah satu dari taksonomi CHATBOT_INTENTS. */
export function isChatbotIntent(v: unknown): v is ChatbotIntent {
  return typeof v === "string" && (CHATBOT_INTENTS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ */
/* Pemisahan TEGAS: pertanyaan ROLE vs profil akun sendiri             */
/* ------------------------------------------------------------------ */
/* "Ada apa saja role pengguna?" BUKAN "Siapa saya?" — pertanyaan tentang
 * jenis role, hak akses, atau daftar pengguna dijawab dari definisi role
 * aplikasi (USER_ROLES / ROLE_PERMISSION / USER_LIST), tidak pernah dari
 * profil akun yang sedang login (ACCOUNT_INFO). */

/** Entitas role/pengguna pada pesan (untuk menautkan frasa ke role). */
const ROLE_ENTITY_RE =
  /\b(?:admin(?:istrator)?|penjual|seller|pembeli|buyer|roles?|peran|pengguna|users?|akun|member|account)\b/;

/** Penanda pertanyaan tentang MILIK SENDIRI → jalur ACCOUNT_INFO. */
const SELF_RE = /\b(?:saya|aku|diriku|sendiri)\b/;

/** Permintaan PERBANDINGAN antar-role ("apa perbedaan ketiganya?", …). */
function wantsRoleCompare(m: string): boolean {
  const cmp =
    /\b(?:perbedaan|beda(?:nya)?|dibandingkan?|perbandingan|membedakan)\b/.test(m);
  const trinity =
    /\bketiganya\b|\bketiga\s+(?:role|akun|pengguna|jenis|peran)\b/.test(m);
  return trinity || (cmp && ROLE_ENTITY_RE.test(m));
}

/** Permintaan HAK AKSES/TUGAS role ("apa tugas admin?", …). */
function wantsRoleDuty(m: string): boolean {
  const duty =
    /\b(?:tugas|kewenangan|wewenang|hak\s+akses|fungsi|kewajiban|kemampuan|bisa\s+apa|boleh\s+apa|apa\s+yang\s+bisa)\b/.test(
      m,
    );
  return duty && ROLE_ENTITY_RE.test(m);
}

/** Permintaan DAFTAR/JENIS role ("ada apa saja role pengguna?", …).
 * Catatan: "siapa saja pengguna/user/member" TIDAK di sini — pertanyaan
 * identitas ("siapa saja penggunanya?") harus menjadi USER_LIST (daftar
 * nama dari database), bukan USER_ROLES (definisi + hitungan). */
function wantsRoleList(m: string): boolean {
  return (
    /\b(?:apa\s+saja|siapa\s+saja|sebutkan|tampilkan|tunjukkan|lihat|daftar|jenis|tipe|macam(?:[-\s]macam)?)\s+(?:role|roles|peran)\b/.test(m) ||
    /\brole\s+(?:pengguna|aplikasi|sistem|di\s+sini|yang\s+ada|tersedia|terdaftar|apa\s+saja)\b/.test(m) ||
    /\bjenis\s+(?:akun|pengguna|user|member)\b/.test(m) ||
    /\bada\s+berapa\s+jenis\b/.test(m) ||
    /\bberapa\s+jenis\s+(?:akun|pengguna|user|member|role)\b/.test(m) ||
    /\bperan\s+(?:pengguna|user|aplikasi|sistem|di\s+sini)\b/.test(m)
  );
}

/** Permintaan DAFTAR pengguna (bukan role) — "daftar pengguna", … → USER_LIST. */
function wantsUserList(m: string): boolean {
  return /\b(?:daftar|list|tampilkan|tunjukkan|lihat|sebutkan|tulis)\s+(?:semua\s+|seluruh\s+|daftar\s+)?(?:pengguna|user|member|akun\s+terdaftar)\b/.test(
    m,
  );
}

/* ------------------------------------------------------------------ */
/* Daftar pengguna MENURUT ROLE — "siapa saja seller?", "tampilkan      */
/* semua nama toko", "sebutkan nama pemilik toko", … → USER_LIST        */
/* dengan target (bukan pertanyaan produk, bukan hitungan, bukan        */
/* definisi role).                                                      */
/* ------------------------------------------------------------------ */

/** Target daftar pengguna yang diminta pertanyaan. */
export type UserListTarget = "SELLER" | "STORE" | "BUYER" | "ADMIN" | "ALL";

/** Penanda permintaan DAFTAR (kata kerja/frasa permintaan pada pesan). */
const LIST_MARKER_RE =
  /\b(?:apa\s+saja|siapa\s+saja|siapa\s+aja|sebutkan|tampilkan|tampilin|tunjukkan|lihat|daftar|list|tulis|menampilkan|menyebutkan|perlihatkan)\b|\bsiapa\s+nama\b/;

/**
 * Deteksi TARGET daftar pengguna dari pesan (murni, tanpa jaringan — diuji
 * unit). Mengembalikan null bila pesan BUKAN permintaan daftar:
 * - pertanyaan JUMLAH ("berapa jumlah seller?", "tampilkan jumlah pengguna
 *   setiap role?") → serahkan ke deteksi hitungan (detectCountQuery);
 * - pertanyaan MILIK SENDIRI ("toko saya") → jalur profil akun;
 * - pertanyaan PRODUK ("tampilkan produk dari toko X") → entitas hanya
 *   diterima di posisi KATA KEPALA setelah penanda, supaya tidak membajak
 *   pertanyaan produk yang kebetulan menyebut toko/penjual.
 */
export function detectUserListTarget(message: string): UserListTarget | null {
  const m = message.toLowerCase();
  // Penanda pertanyaan jumlah → ini bukan daftar.
  if (/\bberapa\b|\bseberapa\b|\bjumlah\b|\bbanyak\b|\bsebanyak\b|\btotal\b/.test(m)) {
    return null;
  }
  // Milik sendiri → bukan daftar global pengguna.
  if (SELF_RE.test(m)) return null;

  // Frasa khusus yang entitasnya menempel pada penanda:
  // "Siapa yang berjualan di Mendung Tirta?" → daftar penjual.
  if (/\bsiapa(?:\s+saja)?\s+(?:yang\s+)?berjualan\b/.test(m)) return "SELLER";

  const marker = LIST_MARKER_RE.exec(m);
  if (!marker) return null;

  // Sisa setelah penanda: hanya kata penyangga (semua/nama/daftar/…) yang
  // boleh dilewati — entitas harus jadi kata pertama yang bermakna.
  // Sufiks -nya/-lah/-kah ("siapa saja penggunanya?") ikut dikenali.
  const rest = m
    .slice(marker.index + marker[0].length)
    .replace(/^\s*(?:(?:semua|seluruh|seluruhnya|daftar|list|nama|yang|para|terdaftar)\s*)*/, "");
  if (/^(?:penjual(?:nya)?|sellers?|pemilik\s+toko|berjualan)\b/.test(rest)) return "SELLER";
  if (/^(?:pembeli(?:nya)?|buyers?)\b/.test(rest)) return "BUYER";
  if (/^(?:admins?(?:nya)?|administrator)\b/.test(rest)) return "ADMIN";
  if (/^(?:toko(?:nya)?|stores?)\b/.test(rest)) return "STORE";
  if (/^(?:pengguna(?:nya)?|users?|akun(?:nya)?|member|account)\b/.test(rest)) return "ALL";
  return null;
}

/**
 * Deteksi intent UTAMA (murni, tanpa jaringan — diuji unit).
 * Urutan prioritas: sapaan → layanan → pertanyaan role/hak akses/daftar
 * pengguna per role ("siapa saja seller?") → hitungan
 * per entitas → akun → laporan penjualan → pendapatan → statistik marketplace
 * → status pesanan → profil toko → produk (harga/stok/kategori/daftar) → umum.
 */
export function detectChatbotIntent(message: string): IntentDetection {
  const m = message.toLowerCase();
  const high = (intent: ChatbotIntent): IntentDetection => ({
    intent,
    confidence: "high",
    source: "deterministic",
  });

  // 1. Sapaan / percakapan ringan → GENERAL (tanpa AI, tanpa data).
  if (isGreetingMessage(message)) return high("GENERAL");

  const intents = detectIntents(message);
  const counts = detectCountQuery(message);

  // 2. Layanan, panduan, aturan → SERVICE_INFO.
  if (intents.has("appinfo")) return high("SERVICE_INFO");

  // 3. Pertanyaan ROLE (jenis/hak akses/daftar pengguna) — SEBELUM hitungan
  //    dan akun: "Ada berapa jenis pengguna?" bukan pertanyaan angka,
  //    "role pengguna" bukan profil akun sendiri. Hanya bila bukan
  //    pertanyaan milik sendiri ("apa peran akun saya?" → ACCOUNT_INFO).
  if (!SELF_RE.test(m)) {
    if (wantsUserList(m)) return high("USER_LIST");
    if (wantsRoleCompare(m)) return high("USER_ROLES");
    if (wantsRoleDuty(m)) return high("ROLE_PERMISSION");
    if (wantsRoleList(m)) return high("USER_ROLES");
    // Daftar pengguna MENURUT ROLE ("siapa saja seller?", "tampilkan semua
    // nama toko", "sebutkan nama pemilik toko", …) → USER_LIST dengan target
    // — SEBELUM hitungan dan produk supaya tidak terjawab daftar produk.
    if (detectUserListTarget(m)) return high("USER_LIST");
  }

  // 4. Hitungan per entitas — spesifik > ringkasan umum.
  if (counts.includes("seller")) return high("SELLER_INFO");
  if (counts.includes("buyer")) return high("BUYER_INFO");
  if (counts.includes("admin") || counts.includes("user")) return high("USER_COUNT");
  if (counts.includes("store")) return high("STORE_INFO");
  if (counts.includes("orders") || counts.includes("paidPayments")) return high("ORDER_COUNT");

  // 5. Profil/kepemilikan akun sendiri → ACCOUNT_INFO.
  if (intents.has("account")) return high("ACCOUNT_INFO");

  // 5b. Kata "statistik" EKSPLISIT → ringkasan marketplace menang atas kata
  //     "pendapatan" di dalamnya ("Tampilkan statistik produk, toko, pesanan,
  //     pendapatan, dan ulasan." → MARKETPLACE_STATS — fetchStats sudah memuat
  //     pendapatan). Kecuali bila yang diminta jelas laporan penjualan.
  if (
    intents.has("stats") &&
    /\bstatistik(?:ka)?\b/.test(m) &&
    !/\b(?:penjualan|terjual|omzet|laporan|terlaris|rekap)\b/.test(m)
  ) {
    return high("MARKETPLACE_STATS");
  }

  // 6. Laporan/rekap penjualan → SALES_REPORT; angka pendapatan → REVENUE.
  if (SALES_REPORT_RE.test(m)) return high("SALES_REPORT");
  if (REVENUE_RE.test(m)) return high("REVENUE");

  // 7. Statistik marketplace (rekap umum) → MARKETPLACE_STATS.
  if (intents.has("stats")) return high("MARKETPLACE_STATS");

  // 8. Status/kedudukan pesanan — termasuk pembeli dari suatu produk
  //    ("Siapa pembeli yang memesan ikan kerapu?" → fetcher khusus).
  if (intents.has("order") || detectBuyersOfProduct(m)) return high("ORDER_STATUS");

  // 9. Profil toko/kepemilikan/peringkat toko → STORE_INFO (SEBELUM aturan
  //    produk: "penjual" mengandung substring "jual" yang memicu intent produk).
  if (STORE_INFO_RE.test(m) || STORE_RANK_RE.test(m)) return high("STORE_INFO");

  // 10. Produk: harga / stok / kategori / daftar pencarian.
  const productish =
    intents.has("product") ||
    intents.has("lowstock") ||
    intents.has("outofstock") ||
    intents.has("reviews") ||
    parsePriceFilter(message) !== null ||
    (extractSubjectPhrase(message) !== null && PRODUCT_CONTEXT_RE.test(m));
  if (productish) {
    if (REVIEW_RE.test(m)) return high("PRODUCT_SEARCH"); // ulasan → data produk
    if (/\bharga(?:nya)?\b/.test(m)) return high("PRODUCT_PRICE");
    if (/\bstok(?:nya)?\b|\bready\b|\bmenipis\b|\bhabis\b/.test(m)) return high("PRODUCT_STOCK");
    if (/\bkategori(?:nya)?\b|\bjenis\b|\btipe\b/.test(m)) return high("PRODUCT_CATEGORY");
    return high("PRODUCT_SEARCH");
  }

  // 11. Tidak ada aturan yang cocok → GENERAL dengan keyakinan rendah
  //     (berpeluang disempurnakan Gemini oleh classifyChatbotIntent).
  return { intent: "GENERAL", confidence: "low", source: "deterministic" };
}

/* ------------------------------------------------------------------ */
/* Penyempurnaan via Gemini (opsional, tahan-gagal)                   */
/* ------------------------------------------------------------------ */

function normalizeParams(raw: unknown): IntentParams | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const p: IntentParams = {};
  if (typeof r.priceMin === "number" && Number.isFinite(r.priceMin)) p.priceMin = r.priceMin;
  if (typeof r.priceMax === "number" && Number.isFinite(r.priceMax)) p.priceMax = r.priceMax;
  if (typeof r.priceMaxExclusive === "boolean") p.priceMaxExclusive = r.priceMaxExclusive;
  if (typeof r.category === "string" && r.category.trim()) p.category = r.category.trim().slice(0, 60);
  if (typeof r.inStock === "boolean") p.inStock = r.inStock;
  if (
    r.sortBy === "price_asc" || r.sortBy === "price_desc" || r.sortBy === "rating" ||
    r.sortBy === "newest" || r.sortBy === "name"
  ) {
    p.sortBy = r.sortBy;
  }
  return Object.keys(p).length > 0 ? p : undefined;
}

/** Satu panggilan Gemini untuk klasifikasi — JSON ketat, timeout pendek,
 *  mengembalikan null bila apa pun tidak valid (tak pernah melempar). */
async function askGeminiIntent(
  runtime: AiRuntime,
  message: string,
  history?: string[],
): Promise<IntentDetection | null> {
  const system = [
    'Kamu adalah classifier maksud (intent) pengguna marketplace "Mendung Tirta" (Bahasa Indonesia).',
    `Pilih SATU kategori dari: ${CHATBOT_INTENTS.join(", ")}.`,
    'Balas HANYA dengan JSON tanpa teks lain: {"intent":"<kategori>"}',
    "Aturan: pertanyaan omzet/pendapatan/pemasukan → REVENUE; laporan/rekap penjualan/produk terlaris → SALES_REPORT; jumlah pesanan → ORDER_COUNT; status/kedudukan pesanan → ORDER_STATUS; jumlah pengguna/akun → USER_COUNT; jenis role/hak akses/daftar role pengguna → USER_ROLES; tugas/hak akses satu role → ROLE_PERMISSION; daftar pengguna menurut role (daftar penjual/toko boleh untuk semua peran; pembeli/pengguna/admin hanya admin) → USER_LIST; jumlah penjual → SELLER_INFO; jumlah pembeli → BUYER_INFO; statistik/rekap marketplace → MARKETPLACE_STATS; profil/kepemilikan akun SENDIRI (siapa saya, peran akun saya) → ACCOUNT_INFO; profil/kepemilikan toko → STORE_INFO; layanan/panduan/aturan → SERVICE_INFO; pertanyaan harga → PRODUCT_PRICE; pertanyaan stok → PRODUCT_STOCK; kategori produk → PRODUCT_CATEGORY; cari/daftar produk → PRODUCT_SEARCH; sisanya → GENERAL. Jangan pernah mengklasifikasi pertanyaan tentang jenis role sebagai ACCOUNT_INFO.",
    "Bila ada, sertakan juga parameter pencarian terstruktur dalam JSON: {\"intent\":\"...\",\"params\":{\"priceMin\":number?,\"priceMax\":number?,\"priceMaxExclusive\":boolean?,\"category\":\"...\"?,\"inStock\":boolean?,\"sortBy\":\"price_asc|price_desc|rating|newest|name\"?}} — hanya untuk intent produk.",
  ].join("\n");
  const ctx =
    history && history.length > 0
      ? `Percakapan sebelumnya (user):\n${history.slice(-4).map((h) => `- ${h.slice(0, 200)}`).join("\n")}\n\n`
      : "";
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `${ctx}Pesan: ${message.slice(0, 500)}` },
  ];

  const res = await fetch(geminiUrl(runtime.baseUrl, runtime.model, false), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": runtime.apiKey as string },
    body: geminiBody(messages, 300),
    signal: AbortSignal.timeout(Math.min(runtime.timeoutMs, 15_000)),
  });
  if (!res.ok) return null;
  const text = geminiText(await res.json()).trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const intent = (parsed as { intent?: unknown } | null)?.intent;
  if (!isChatbotIntent(intent)) return null;
  return {
    intent,
    confidence: "high",
    source: "gemini",
    params: normalizeParams((parsed as { params?: unknown } | null)?.params),
  };
}

/**
 * Klasifikasi intent FINAL: deterministik dulu (instan, andal); bila tidak
 * yakin DAN pesan mengandung sinyal data → tanyakan Gemini untuk memahami
 * bahasa alami/sinonim/konteks percakapan. Hasil disimpan singkat (cache
 * 60 detik per pesan) agar pertanyaan berulang tidak memanggil provider
 * berulang. Kegagalan apa pun → hasil deterministik (tak pernah melempar).
 */
export async function classifyChatbotIntent(
  message: string,
  history?: string[],
): Promise<IntentDetection> {
  const det = detectChatbotIntent(message);
  if (det.confidence === "high") return det;
  if (!DATA_SIGNAL_RE.test(message)) return det;

  try {
    const runtime = await resolveAiRuntime();
    if (!runtime.apiKey) return det;
    const refined = await cached(
      `intent:${message.toLowerCase().slice(0, 200)}`,
      () => askGeminiIntent(runtime, message, history),
      60_000,
    );
    if (refined) return refined;
  } catch (err) {
    // Catat AMAN tanpa detail/key → pakai deteksi deterministik.
    console.warn(
      "[ai-intent] klasifikasi Gemini gagal → memakai deteksi deterministik.",
      err instanceof Error ? err.name : typeof err,
    );
  }
  return det;
}

/**
 * Padukan parameter terstruktur dari Gemini ke filter hasil ekstraksi
 * deterministik — HANYA mengisi kolom yang masih kosong (deteksi lokal
 * tetap menang bila sudah menemukan sendiri). Mengembalikan objek baru.
 */
export function mergeIntentParams(filters: ProductFilter, params?: IntentParams): ProductFilter {
  if (!params) return filters;
  const out: ProductFilter = { ...filters };
  if (out.price === undefined && (params.priceMin !== undefined || params.priceMax !== undefined)) {
    out.price = {
      min: params.priceMin,
      max: params.priceMax,
      maxExclusive: params.priceMaxExclusive ?? params.priceMax !== undefined,
    };
  }
  if (out.category === undefined && params.category) out.category = params.category;
  if (out.inStock === undefined && params.inStock !== undefined) out.inStock = params.inStock;
  if (out.sortBy === undefined && params.sortBy) out.sortBy = params.sortBy;
  return out;
}

import Link from "next/link";
import { SiteNav } from "@/components/layout/SiteNav";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { ProductCard } from "@/components/product/ProductCard";
import { listCategories, listProducts } from "@/lib/catalog";
import "./home.css";

export const dynamic = "force-dynamic";

const CATEGORY_IMAGES: Record<string, string> = {
  "Hasil Laut": "/images/products/kategori-hasil-laut.jpg",
  "Alat Pancing": "/images/products/kategori-alat-pancing.jpg",
  Umpan: "/images/products/kategori-umpan.jpg",
};

const FEATURES = [
  {
    title: "Segar dari sumbernya",
    text: "Hasil tangkapan dikirim hari yang sama oleh nelayan lokal, tanpa rantai distribusi panjang.",
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 14c3-4.5 6.5-7 10.5-7 3 0 5.5 1.6 7.5 4.6l1.5 2.4-1.5 2.4C19 19.4 16.5 21 13.5 21 9.5 21 6 18.5 3 14Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="M20.5 14 24 10v8l-3.5-4Z" fill="currentColor" />
        <circle cx="9" cy="12.5" r="1.4" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: "Penjual terverifikasi",
    text: "Toko dan penjual dikelola langsung oleh admin platform sehingga identitasnya jelas.",
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3 20 6v6c0 4.4-3.4 7.9-8 9-4.6-1.1-8-4.6-8-9V6l8-3Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
        <path d="m8.5 12 2.4 2.4 4.6-4.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: "Harga transparan",
    text: "Harga, satuan, dan stok ditampilkan apa adanya. Tidak ada biaya tersembunyi.",
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
        <path d="M9 8.5h6M9 12h6M12 8.5v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: "Dibantu asisten AI",
    text: "Tanyakan produk, stok, hingga rekomendasi menu — asisten kami siap 24 jam.",
    icon: (
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="4" y="6" width="16" height="13" rx="4" stroke="currentColor" strokeWidth="1.7" />
        <path d="M12 3v3M9 12h.01M15 12h.01M9 15.5c1.8 1.2 4.2 1.2 6 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    ),
  },
];

export default async function Home() {
  const [featured, categories] = await Promise.all([
    listProducts({ sort: "rating", limit: 8 }),
    listCategories(),
  ]);

  const products = featured.items;

  return (
    <div className="home-wrapper">
      <SiteNav />

      <main>
        {/* ============ HERO ============ */}
        <section className="hero">
          <div className="hero-bg" aria-hidden="true">
            <span className="hero-blob hero-blob-1" />
            <span className="hero-blob hero-blob-2" />
            <span className="hero-wave" />
          </div>

          <div className="container hero-grid">
            <div className="hero-copy">
              <span className="hero-badge">
                <span className="hero-badge-dot" aria-hidden="true" />
                Marketplace nelayan &amp; pemancing lokal
              </span>
              <h1 className="animate-fade-up">Dari Laut ke Meja Anda.</h1>
              <p className="hero-subtitle animate-fade-up delay-1">
                Belanja hasil laut segar dan perlengkapan memancing berkualitas langsung
                dari nelayan serta toko lokal terpercaya — segar, cepat, dan harga adil.
              </p>
              <div className="hero-actions animate-fade-up delay-2">
                <Link href="/products?kategori=Hasil%20Laut" className="btn btn-primary">
                  Beli Hasil Panen
                </Link>
                <Link href="/products?kategori=Alat%20Pancing" className="btn btn-accent">
                  Cari Alat Pancing
                </Link>
              </div>
              <div className="hero-trust animate-fade-up delay-3">
                <div>
                  <strong>{featured.total}+</strong>
                  <span>produk aktif</span>
                </div>
                <div>
                  <strong>{categories.length}</strong>
                  <span>kategori pilihan</span>
                </div>
                <div>
                  <strong>24/7</strong>
                  <span>asisten AI</span>
                </div>
              </div>
            </div>

            <div className="hero-visual animate-fade-up delay-1">
              <div className="hero-photo hero-photo-main">
                {/* eslint-disable-next-line @next/next/no-img-element -- aset statis lokal */}
                <img
                  src="/images/products/hero-laut.jpg"
                  alt="Aneka hasil laut segar di pasar ikan"
                  loading="eager"
                  decoding="async"
                />
              </div>
              <div className="hero-float hero-float-top">
                <span className="hero-float-icon" aria-hidden="true">✓</span>
                <div>
                  <strong>Tangkapan hari ini</strong>
                  <small>Langsung dari dermaga</small>
                </div>
              </div>
              <div className="hero-float hero-float-bottom">
                <div className="hero-float-stars" aria-hidden="true">★★★★★</div>
                <div>
                  <strong>4.8/5</strong>
                  <small>Ulasan pembeli lokal</small>
                </div>
              </div>
              <div className="hero-photo hero-photo-small">
                {/* eslint-disable-next-line @next/next/no-img-element -- aset statis lokal */}
                <img
                  src="/images/products/reel-spinning.jpg"
                  alt="Reel pancing spinning"
                  loading="lazy"
                  decoding="async"
                />
              </div>
            </div>
          </div>
        </section>

        {/* ============ KATEGORI ============ */}
        <section className="home-section" aria-labelledby="kategori-heading">
          <div className="container">
            <div className="section-head">
              <div>
                <span className="section-eyebrow">Jelajahi kategori</span>
                <h2 id="kategori-heading" className="section-title">
                  Semua kebutuhan laut &amp; pancing
                </h2>
                <p className="section-sub">
                  Pilih kategori untuk melihat produk yang tersedia langsung dari toko lokal.
                </p>
              </div>
              <Link href="/products" className="section-link">
                Lihat semua produk <span aria-hidden="true">→</span>
              </Link>
            </div>

            <div className="category-grid">
              {categories.map((c) => {
                const image = CATEGORY_IMAGES[c.name];
                return (
                  <Link
                    key={c.id}
                    href={`/products?kategori=${encodeURIComponent(c.name)}`}
                    className="category-card"
                  >
                    {image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- aset statis lokal
                      <img src={image} alt={`Kategori ${c.name}`} loading="lazy" decoding="async" />
                    ) : (
                      <span className="category-card-placeholder" aria-hidden="true" />
                    )}
                    <span className="category-card-overlay" />
                    <span className="category-card-content">
                      <strong>{c.name}</strong>
                      <span>{c.productCount} produk</span>
                    </span>
                    <span className="category-card-arrow" aria-hidden="true">→</span>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        {/* ============ PRODUK UNGGULAN ============ */}
        <section className="home-section home-section-featured" aria-labelledby="unggulan-heading">
          <div className="container">
            <div className="section-head">
              <div>
                <span className="section-eyebrow">Pilihan terbaik</span>
                <h2 id="unggulan-heading" className="section-title">
                  Produk unggulan minggu ini
                </h2>
                <p className="section-sub">
                  Rating tertinggi dari pembeli, siap dikirim dari penjual terverifikasi.
                </p>
              </div>
              <Link href="/products" className="section-link">
                Katalog lengkap <span aria-hidden="true">→</span>
              </Link>
            </div>

            {products.length === 0 ? (
              <div className="home-empty">
                <p>Belum ada produk yang tampil saat ini.</p>
                <Link href="/products" className="btn btn-primary">
                  Buka katalog
                </Link>
              </div>
            ) : (
              <div className="product-grid">
                {products.map((p) => (
                  <ProductCard key={p.id} product={p} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ============ KEUNGGULAN ============ */}
        <section id="features" className="home-section" aria-labelledby="keunggulan-heading">
          <div className="container">
            <div className="section-head section-head-center">
              <div>
                <span className="section-eyebrow">Mengapa Mendung Tirta</span>
                <h2 id="keunggulan-heading" className="section-title">
                  Belanja lokal yang aman dan menyenangkan
                </h2>
              </div>
            </div>
            <div className="why-grid">
              {FEATURES.map((f) => (
                <div key={f.title} className="why-card">
                  <span className="why-icon" aria-hidden="true">
                    {f.icon}
                  </span>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ============ INFORMASI ============ */}
        <section id="informasi" className="home-section info-section" aria-labelledby="info-heading">
          <span id="about" className="anchor-target" aria-hidden="true" />
          <div className="container info-grid">
            <div className="info-copy">
              <span className="section-eyebrow">Tentang kami</span>
              <h2 id="info-heading" className="section-title">
                Menghubungkan dermaga dengan meja makan Anda
              </h2>
              <p>
                <strong>Mendung Tirta</strong> lahir dari kota pinggir laut. Kami menghubungkan
                nelayan dan penjual perlengkapan memancing lokal langsung dengan pembeli —
                tanpa perantara berlebihan, dengan sistem yang melindungi kedua pihak.
              </p>
              <p>
                Setiap penjual dan toko dikelola melalui panel admin, sehingga identitas,
                status, dan produk yang dijual selalu jelas. Pembeli dapat memantau pesanan,
                memberi ulasan, dan berkonsultasi dengan asisten AI kapan saja.
              </p>
              <div className="info-points">
                <div>
                  <strong>Pembayaran aman</strong>
                  <span>Status pembayaran tercatat rapi di sistem.</span>
                </div>
                <div>
                  <strong>Dukungan lokal</strong>
                  <span>Setiap transaksi membantu nelayan &amp; toko sekitar.</span>
                </div>
              </div>
            </div>

            <aside className="info-card">
              <h3>Kunjungi &amp; hubungi</h3>
              <ul>
                <li>
                  <span aria-hidden="true">📍</span>
                  <div>
                    <strong>Alamat</strong>
                    <p>Dermaga Timur, Kota Pesisir</p>
                  </div>
                </li>
                <li>
                  <span aria-hidden="true">🕘</span>
                  <div>
                    <strong>Jam operasional</strong>
                    <p>Senin–Sabtu · 07.00–18.00</p>
                  </div>
                </li>
                <li>
                  <span aria-hidden="true">✉️</span>
                  <div>
                    <strong>Email</strong>
                    <p>halo@mendungtirta.com</p>
                  </div>
                </li>
                <li>
                  <span aria-hidden="true">💬</span>
                  <div>
                    <strong>Asisten AI</strong>
                    <p>Klik tombol chat di kanan bawah, kapan saja.</p>
                  </div>
                </li>
              </ul>
            </aside>
          </div>
        </section>

        {/* ============ CTA ============ */}
        <section className="home-section">
          <div className="container">
            <div className="cta-banner">
              <div>
                <span className="section-eyebrow" style={{ color: "rgba(255,255,255,0.8)" }}>
                  Siap belanja?
                </span>
                <h2>Hari ini segar, besok di dapur Anda.</h2>
                <p>
                  Temukan hasil laut terbaik dan perlengkapan pancing favoritmu di Mendung Tirta.
                </p>
              </div>
              <div className="cta-actions">
                <Link href="/products" className="btn btn-accent">
                  Mulai belanja
                </Link>
                <Link href="/register" className="btn btn-ghost">
                  Daftar gratis
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

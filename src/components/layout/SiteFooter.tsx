import Link from "next/link";

/** Footer global yang dipakai landing, katalog, dan detail produk. */
export function SiteFooter() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <p className="footer-brand">
              Mendung <span>Tirta</span>
            </p>
            <p style={{ fontSize: "0.92rem", maxWidth: 300 }}>
              Marketplace hasil laut segar dan perlengkapan memancing dari nelayan serta
              toko lokal. Dari laut ke meja Anda, tanpa perantara berlebihan.
            </p>
          </div>

          <div className="footer-col">
            <h3>Jelajahi</h3>
            <ul>
              <li>
                <Link href="/products">Katalog produk</Link>
              </li>
              <li>
                <Link href="/products?kategori=Hasil%20Laut">Hasil laut</Link>
              </li>
              <li>
                <Link href="/products?kategori=Alat%20Pancing">Alat pancing</Link>
              </li>
              <li>
                <Link href="/#informasi">Informasi</Link>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h3>Akun</h3>
            <ul>
              <li>
                <Link href="/login">Masuk</Link>
              </li>
              <li>
                <Link href="/register">Daftar</Link>
              </li>
              <li>
                <Link href="/cart">Keranjang</Link>
              </li>
              <li>
                <Link href="/buyer">Pesanan saya</Link>
              </li>
            </ul>
          </div>

          <div className="footer-col">
            <h3>Hubungi Kami</h3>
            <ul>
              <li>Dermaga Timur, Kota Pesisir</li>
              <li>Senin–Sabtu · 07.00–18.00</li>
              <li>halo@mendungtirta.com</li>
              <li>+62 812 0000 0000</li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <span>&copy; {new Date().getFullYear()} Mendung Tirta. Hak cipta dilindungi.</span>
          <span>Dibuat untuk nelayan &amp; pemancing lokal.</span>
        </div>
      </div>
    </footer>
  );
}

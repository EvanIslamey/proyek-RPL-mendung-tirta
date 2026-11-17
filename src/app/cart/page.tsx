"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { SiteNav } from "@/components/layout/SiteNav";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { ProductImage } from "@/components/product/ProductImage";
import { formatRupiah } from "@/components/product/ProductCard";
import { useCart } from "@/components/cart/CartContext";
import "../products/products.css";
import "./checkout.css";

export default function CartPage() {
  const router = useRouter();
  const { items, total, loading, updateQuantity, removeItem } = useCart();

  if (loading) {
    return (
      <div className="market-wrapper">
        <SiteNav />
        <main className="container cart-main" aria-busy="true">
          <p className="market-result-count">Memuat keranjang…</p>
        </main>
      </div>
    );
  }

  return (
    <div className="market-wrapper">
      <SiteNav />

      <main className="container cart-main">
        <div className="cart-head">
          <span className="section-eyebrow">Keranjang</span>
          <h1>Keranjang Belanja</h1>
          <p className="cart-subtitle">
            Periksa kembali produk dan jumlahnya sebelum melanjutkan ke checkout.
          </p>
        </div>

        {items.length === 0 ? (
          <div className="market-empty">
            <div className="market-empty-icon" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="10" cy="20" r="1.4" fill="currentColor" />
                <circle cx="18" cy="20" r="1.4" fill="currentColor" />
              </svg>
            </div>
            <h2>Keranjang masih kosong</h2>
            <p>Yuk, pilih perlengkapan memancing atau hasil panen segar favorit Anda.</p>
            <Link href="/products" className="btn btn-primary">Lihat Katalog</Link>
          </div>
        ) : (
          <div className="cart-layout">
            <ul className="cart-list">
              {items.map((item) => (
                <li key={item.productId} className="cart-item">
                  <div className="cart-item-media">
                    <ProductImage src={item.image} alt={item.name} />
                  </div>
                  <div className="cart-item-info">
                    <Link href={`/products/${item.productId}`} className="cart-item-name">
                      {item.name}
                    </Link>
                    <p className="cart-item-store">{item.storeName}</p>
                    <p className="cart-item-price">{formatRupiah(item.price)}</p>
                    {item.quantity >= item.stock && (
                      <p className="cart-item-stock-note">Maksimal stok tersedia: {item.stock}</p>
                    )}
                  </div>
                  <div className="cart-item-actions">
                    <div className="qty-control">
                      <button
                        type="button"
                        aria-label="Kurangi jumlah"
                        onClick={() => updateQuantity(item.productId, item.quantity - 1)}
                      >
                        −
                      </button>
                      <span aria-label="Jumlah">{item.quantity}</span>
                      <button
                        type="button"
                        aria-label="Tambah jumlah"
                        onClick={() => updateQuantity(item.productId, item.quantity + 1)}
                        disabled={item.quantity >= item.stock}
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      className="cart-remove"
                      onClick={() => removeItem(item.productId)}
                    >
                      Hapus
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            <aside className="cart-summary">
              <h2>Ringkasan</h2>
              <div className="cart-summary-row">
                <span>Subtotal</span>
                <strong>{formatRupiah(total)}</strong>
              </div>
              <div className="cart-summary-row muted">
                <span>Ongkir</span>
                <span>Dihitung saat pengiriman</span>
              </div>
              <hr />
              <div className="cart-summary-row total">
                <span>Total</span>
                <strong>{formatRupiah(total)}</strong>
              </div>
              <button
                type="button"
                className="btn btn-primary cart-checkout-btn"
                onClick={() => router.push("/checkout")}
              >
                Lanjut ke Checkout
              </button>
              <Link href="/products" className="cart-continue">Lanjut belanja</Link>
            </aside>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { SiteNav } from "@/components/layout/SiteNav";
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
        <h1>Keranjang Belanja</h1>

        {items.length === 0 ? (
          <div className="market-empty">
            <div className="market-empty-icon" aria-hidden="true">🛒</div>
            <h2>Keranjang masih kosong</h2>
            <p>Yuk, pilih perlengkapan memancing atau hasil panen segar favorit Anda.</p>
            <Link href="/products" className="btn btn-primary">Lihat Katalog</Link>
          </div>
        ) : (
          <div className="cart-layout">
            <ul className="cart-list">
              {items.map((item) => (
                <li key={item.productId} className="cart-item">
                  <div className="cart-item-media" aria-hidden="true">🐟</div>
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
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SiteNav } from "@/components/layout/SiteNav";
import { formatRupiah } from "@/components/product/ProductCard";
import { useCart } from "@/components/cart/CartContext";
import "../auth.css";
import "../products/products.css";
import "../cart/checkout.css";

type SessionUser = { id: string; name: string; address: string | null };

export default function CheckoutPage() {
  const router = useRouter();
  const { items, total, loading: cartLoading, clearCart } = useCart();

  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cek sesi + ambil alamat default.
  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d: { user?: SessionUser | null }) => {
        if (!alive) return;
        setUser(d.user ?? null);
        if (d.user?.address) setAddress(d.user.address);
      })
      .catch(() => alive && setUser(null));
    return () => {
      alive = false;
    };
  }, []);

  async function onCheckout(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = address.trim();
    if (trimmed.length < 5) {
      setError("Alamat pengiriman minimal 5 karakter.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingAddress: trimmed,
          items: items.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        }),
      });
      const data: { message?: string; orderId?: string } = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.message ?? "Checkout gagal. Coba lagi.");
        return;
      }

      clearCart();
      router.push(`/orders/${data.orderId}?new=1`);
    } catch {
      setError("Tidak dapat terhubung ke server. Periksa koneksi Anda.");
    } finally {
      setSubmitting(false);
    }
  }

  // Masih memuat sesi/keranjang.
  if (user === undefined || cartLoading) {
    return (
      <div className="market-wrapper">
        <SiteNav />
        <main className="container checkout-main" aria-busy="true">
          <p className="market-result-count">Memuat…</p>
        </main>
      </div>
    );
  }

  // Belum login → arahkan ke login (kembali ke checkout setelah masuk).
  if (user === null) {
    return (
      <div className="market-wrapper">
        <SiteNav />
        <main className="container checkout-main">
          <div className="market-empty">
            <div className="market-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="10" width="16" height="10" rx="2.5" />
                <path d="M8 10V7.5a4 4 0 0 1 8 0V10" />
                <circle cx="12" cy="15" r="1.2" />
              </svg>
            </div>
            <h2>Silakan masuk terlebih dahulu</h2>
            <p>Anda perlu login untuk menyelesaikan pesanan.</p>
            <Link href="/login?next=/checkout" className="btn btn-primary">Masuk</Link>
          </div>
        </main>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="market-wrapper">
        <SiteNav />
        <main className="container checkout-main">
          <div className="market-empty">
            <div className="market-empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6" />
                <circle cx="10" cy="20" r="1.3" />
                <circle cx="18" cy="20" r="1.3" />
              </svg>
            </div>
            <h2>Keranjang kosong</h2>
            <p>Tambahkan produk sebelum melakukan checkout.</p>
            <Link href="/products" className="btn btn-primary">Lihat Katalog</Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="market-wrapper">
      <SiteNav />

      <main className="container checkout-main">
        <h1>Checkout</h1>

        <div className="cart-layout">
          <form className="checkout-form" onSubmit={onCheckout}>
            {error && (
              <div className="market-alert" role="alert">
                <p>{error}</p>
              </div>
            )}

            <div className="auth-field">
              <label htmlFor="shippingAddress">Alamat pengiriman</label>
              <textarea
                id="shippingAddress"
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Nama penerima, jalan, nomor rumah, kecamatan, kota"
                required
              />
              <p className="auth-hint">
                Total akan dihitung ulang oleh server saat pesanan diproses.
              </p>
            </div>

            <section className="checkout-items" aria-label="Ringkasan produk">
              <h2>Produk ({items.length})</h2>
              <ul>
                {items.map((i) => (
                  <li key={i.productId}>
                    <span className="checkout-item-name">
                      {i.name} <span className="muted">× {i.quantity}</span>
                    </span>
                    <span>{formatRupiah(i.price * i.quantity)}</span>
                  </li>
                ))}
              </ul>
            </section>

            <button type="submit" className="btn btn-primary checkout-submit" disabled={submitting}>
              {submitting ? "Memproses…" : `Buat Pesanan — ${formatRupiah(total)}`}
            </button>
          </form>

          <aside className="cart-summary">
            <h2>Rincian Biaya</h2>
            <div className="cart-summary-row">
              <span>Subtotal</span>
              <strong>{formatRupiah(total)}</strong>
            </div>
            <div className="cart-summary-row muted">
              <span>Pembayaran</span>
              <span>Dummy (MVP)</span>
            </div>
            <hr />
            <div className="cart-summary-row total">
              <span>Total</span>
              <strong>{formatRupiah(total)}</strong>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { SiteNav } from "@/components/layout/SiteNav";
import { formatRupiah } from "@/components/product/ProductCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import "../products/products.css";
import "../cart/checkout.css";

type OrderListItem = {
  id: string;
  status: string;
  total: number;
  createdAt: string;
  paymentStatus: string | null;
  items: { productId: string; name: string; quantity: number; price: number }[];
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<OrderListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(() => {
    fetch("/api/orders", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) {
          setNeedsLogin(true);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { orders?: OrderListItem[] } | null) => {
        if (d) setOrders(d.orders ?? []);
      })
      .catch(() => setError("Gagal memuat pesanan. Coba lagi."));
  }, []);

  useEffect(() => {
    load();
  }, [load, reload]);

  return (
    <div className="market-wrapper">
      <SiteNav />

      <main className="container cart-main">
        <h1>Pesanan Saya</h1>

        {needsLogin && (
          <div className="market-empty">
            <div className="market-empty-icon" aria-hidden="true">🔐</div>
            <h2>Silakan masuk</h2>
            <p>Login untuk melihat riwayat pesanan Anda.</p>
            <Link href="/login?next=/orders" className="btn btn-primary">Masuk</Link>
          </div>
        )}

        {error && !needsLogin && (
          <div className="market-alert" role="alert">
            <p>{error}</p>
            <button type="button" className="btn btn-primary" onClick={() => setReload((r) => r + 1)}>
              Coba lagi
            </button>
          </div>
        )}

        {orders !== null && orders.length === 0 && !error && (
          <div className="market-empty">
            <div className="market-empty-icon" aria-hidden="true">📦</div>
            <h2>Belum ada pesanan</h2>
            <p>Pesanan Anda akan muncul di sini setelah checkout.</p>
            <Link href="/products" className="btn btn-primary">Mulai Belanja</Link>
          </div>
        )}

        {orders !== null && orders.length > 0 && (
          <ul className="order-list">
            {orders.map((order) => (
              <li key={order.id} className="order-card">
                <div className="order-card-head">
                  <div>
                    <Link href={`/orders/${order.id}`} className="order-id">
                      Pesanan #{order.id.slice(0, 8)}
                    </Link>
                    <p className="order-date">
                      {new Date(order.createdAt).toLocaleDateString("id-ID", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                  <StatusBadge status={order.status} />
                </div>
                <ul className="order-items-mini">
                  {order.items.slice(0, 3).map((i, idx) => (
                    <li key={idx}>
                      {i.name} <span className="muted">× {i.quantity}</span>
                    </li>
                  ))}
                  {order.items.length > 3 && (
                    <li className="muted">+{order.items.length - 3} produk lainnya</li>
                  )}
                </ul>
                <div className="order-card-foot">
                  <strong className="order-total">{formatRupiah(order.total)}</strong>
                  <Link href={`/orders/${order.id}`} className="order-detail-link">
                    Lihat detail →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

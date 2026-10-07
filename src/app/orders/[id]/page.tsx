"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { SiteNav } from "@/components/layout/SiteNav";
import { formatRupiah } from "@/components/product/ProductCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import "../../products/products.css";
import "../../cart/checkout.css";

type OrderDetail = {
  id: string;
  status: string;
  total: number;
  shippingAddress: string;
  createdAt: string;
  paymentStatus: string | null;
  paidAt: string | null;
  buyer: { id: string; name: string };
  items: {
    productId: string;
    name: string;
    storeName: string;
    quantity: number;
    price: number;
  }[];
};

function OrderDetailContent() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const isNew = searchParams.get("new") === "1";

  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const load = useCallback(() => {
    fetch(`/api/orders/${params.id}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).message ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { order?: OrderDetail }) => {
        if (d.order) setOrder(d.order);
        else setError("Pesanan tidak ditemukan.");
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Gagal memuat pesanan."),
      );
  }, [params.id]);

  useEffect(() => {
    load();
  }, [load, reload]);

  async function postAction(action: "pay" | "cancel") {
    if (busy || !order) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(
        action === "pay" ? `/api/orders/${order.id}/pay` : `/api/orders/${order.id}`,
        {
          method: action === "pay" ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: action === "pay" ? "{}" : JSON.stringify({ action: "cancel" }),
        },
      );
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setActionError(data.message ?? "Aksi gagal.");
        return;
      }
      setReload((r) => r + 1);
    } catch {
      setActionError("Tidak dapat terhubung ke server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="market-wrapper">
      <SiteNav />

      <main className="container cart-main">
        <nav className="detail-breadcrumb" aria-label="Breadcrumb">
          <Link href="/orders">Pesanan Saya</Link>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">Detail</span>
        </nav>

        {error && (
          <div className="market-alert" role="alert">
            <p>{error}</p>
            <Link href="/orders" className="btn btn-primary">Kembali ke Pesanan</Link>
          </div>
        )}

        {!error && !order && (
          <p className="market-result-count" aria-busy="true">Memuat pesanan…</p>
        )}

        {order && (
          <>
            {isNew && (
              <div className="order-success" role="status">
                ✅ Pesanan berhasil dibuat! Silakan selesaikan pembayaran (dummy) di bawah.
              </div>
            )}

            <div className="order-card-head">
              <div>
                <h1 className="order-detail-title">Pesanan #{order.id.slice(0, 8)}</h1>
                <p className="order-date">
                  {new Date(order.createdAt).toLocaleString("id-ID", {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
              <StatusBadge status={order.status} />
            </div>

            {actionError && (
              <div className="market-alert" role="alert">
                <p>{actionError}</p>
              </div>
            )}

            <div className="cart-layout" style={{ marginTop: "1.25rem" }}>
              <div>
                <section className="checkout-items" aria-label="Item pesanan">
                  <h2>Produk</h2>
                  <ul>
                    {order.items.map((i) => (
                      <li key={i.productId}>
                        <span className="checkout-item-name">
                          <Link href={`/products/${i.productId}`}>{i.name}</Link>{" "}
                          <span className="muted">
                            × {i.quantity} — {i.storeName}
                          </span>
                        </span>
                        <span>{formatRupiah(i.price * i.quantity)}</span>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="checkout-items" aria-label="Alamat pengiriman">
                  <h2>Alamat Pengiriman</h2>
                  <p>{order.shippingAddress}</p>
                </section>
              </div>

              <aside className="cart-summary">
                <h2>Pembayaran</h2>
                <div className="cart-summary-row">
                  <span>Status</span>
                  {order.paymentStatus ? <StatusBadge status={order.paymentStatus} /> : <span>—</span>}
                </div>
                <div className="cart-summary-row muted">
                  <span>Metode</span>
                  <span>Dummy (MVP)</span>
                </div>
                <hr />
                <div className="cart-summary-row total">
                  <span>Total</span>
                  <strong>{formatRupiah(order.total)}</strong>
                </div>

                {order.status === "PENDING" && (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary cart-checkout-btn"
                      onClick={() => postAction("pay")}
                      disabled={busy}
                    >
                      {busy ? "Memproses…" : "Bayar Sekarang (Dummy)"}
                    </button>
                    <button
                      type="button"
                      className="cart-continue cart-cancel-btn"
                      onClick={() => {
                        if (window.confirm("Batalkan pesanan ini?")) postAction("cancel");
                      }}
                      disabled={busy}
                    >
                      Batalkan Pesanan
                    </button>
                  </>
                )}

                {order.status === "PROCESSING" && (
                  <p className="order-note">Pembayaran diterima — penjual sedang memproses pesanan Anda.</p>
                )}
                {order.status === "COMPLETED" && (
                  <p className="order-note">Terima kasih! Pesanan Anda sudah selesai. 🎉</p>
                )}
                {order.status === "CANCELLED" && (
                  <p className="order-note">Pesanan ini dibatalkan.</p>
                )}
              </aside>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default function OrderDetailPage() {
  return (
    <Suspense fallback={null}>
      <OrderDetailContent />
    </Suspense>
  );
}

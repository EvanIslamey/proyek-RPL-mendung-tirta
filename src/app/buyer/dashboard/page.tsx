"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { formatRupiah } from "@/components/product/ProductCard";

type OrderListItem = {
  id: string;
  status: string;
  total: number;
  createdAt: string;
  paymentStatus: string | null;
  items: { productId: string; name: string; quantity: number; price: number }[];
};

const STATUS_GROUPS = [
  { label: "Menunggu Pembayaran", statuses: ["PENDING"] },
  { label: "Sedang Diproses", statuses: ["PROCESSING", "SHIPPED", "READY_FOR_PICKUP"] },
  { label: "Selesai", statuses: ["COMPLETED"] },
] as const;

function countByStatuses(orders: OrderListItem[], statuses: readonly string[]): number {
  return orders.filter((o) => statuses.includes(o.status)).length;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Dashboard Pembeli — ringkasan aktivitas BELANJA:
 * jumlah pesanan per kelompok status, pesanan terbaru, dan tautan cepat
 * ke riwayat pesanan / katalog / profil. BUKAN halaman profil
 * (profil & password ada di /buyer).
 */
export default function BuyerDashboardPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<OrderListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(() => {
    fetch("/api/orders", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) {
          router.push("/login?next=/buyer/dashboard");
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = (await r.json()) as { orders: OrderListItem[] };
        setOrders(d.orders);
        setError(null);
        return null;
      })
      .catch(() => setError("Gagal memuat ringkasan pesanan. Coba lagi."))
      .finally(() => setOrders((o) => o ?? []));
  }, [router]);

  useEffect(() => {
    load();
  }, [load, reload, router]);

  const recent = (orders ?? []).slice(0, 5);
  const totalSpent = (orders ?? [])
    .filter((o) => o.status !== "CANCELLED")
    .reduce((a, o) => a + o.total, 0);

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Dashboard Pembeli</h1>
          <p>Ringkasan aktivitas belanja Anda di Mendung Tirta</p>
        </div>
        <button
          type="button"
          className="btn btn-sm btn-outline"
          onClick={() => setReload((r) => r + 1)}
        >
          Muat ulang
        </button>
      </div>

      {error && (
        <div className="form-error-banner" role="alert">
          {error}{" "}
          <button type="button" className="btn btn-sm btn-outline" onClick={() => setReload((r) => r + 1)}>
            Coba lagi
          </button>
        </div>
      )}

      {!orders && !error && (
        <div className="dash-loading" aria-busy="true">
          Memuat ringkasan…
        </div>
      )}

      {orders && (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-label">Total Pesanan</span>
              <span className="stat-value">{orders.length}</span>
              <span className="stat-sub">sepanjang waktu</span>
            </div>
            {STATUS_GROUPS.map((g) => (
              <div className="stat-card" key={g.label}>
                <span className="stat-label">{g.label}</span>
                <span className="stat-value">{countByStatuses(orders, g.statuses)}</span>
                <span className="stat-sub">pesanan</span>
              </div>
            ))}
            <div className="stat-card">
              <span className="stat-label">Total Belanja</span>
              <span className="stat-value" style={{ fontSize: "1.25rem" }}>
                {formatRupiah(totalSpent)}
              </span>
              <span className="stat-sub">tanpa pesanan dibatalkan</span>
            </div>
          </div>

          <section className="dash-panel">
            <h2>Pesanan Terbaru</h2>
            {recent.length === 0 ? (
              <div className="dash-empty">
                <strong>Belum ada pesanan</strong>
                Mulai belanja dari katalog untuk membuat pesanan pertama Anda.
                <div style={{ marginTop: "0.75rem" }}>
                  <Link href="/products" className="btn btn-primary btn-sm">
                    🛍 Belanja Sekarang
                  </Link>
                </div>
              </div>
            ) : (
              <div className="dash-table-wrap">
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Pesanan</th>
                      <th>Tanggal</th>
                      <th>Status</th>
                      <th className="num">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <Link href={`/orders/${o.id}`}>#{o.id.slice(0, 8)}</Link>
                          <span style={{ display: "block", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                            {o.items
                              .slice(0, 2)
                              .map((i) => `${i.name} ×${i.quantity}`)
                              .join(", ")}
                            {o.items.length > 2 && ` +${o.items.length - 2} lainnya`}
                          </span>
                        </td>
                        <td>{formatDate(o.createdAt)}</td>
                        <td>
                          <StatusBadge status={o.status} />
                        </td>
                        <td className="num">{formatRupiah(o.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="dash-panel">
            <h2>Tautan Cepat</h2>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem" }}>
              <Link href="/orders" className="btn btn-outline btn-sm">
                🧾 Riwayat Pesanan
              </Link>
              <Link href="/products" className="btn btn-outline btn-sm">
                🛍 Katalog Produk
              </Link>
              <Link href="/cart" className="btn btn-outline btn-sm">
                🛒 Keranjang
              </Link>
              <Link href="/buyer" className="btn btn-outline btn-sm">
                👤 Informasi Diri &amp; Password
              </Link>
            </div>
          </section>
        </>
      )}
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { formatRupiah } from "@/lib/format";

type Stats = {
  users: { total: number; byRole: Record<string, number> };
  stores: { total: number; active: number; inactive: number };
  products: { total: number; byStatus: Record<string, number> };
  orders: { total: number; byStatus: Record<string, number> };
  revenue: number;
  reviews: { total: number; average: number };
};

const ORDER_STATUS_LABELS: Record<string, string> = {
  PENDING: "Menunggu Pembayaran",
  PROCESSING: "Diproses",
  SHIPPED: "Dikirim",
  READY_FOR_PICKUP: "Siap Diambil",
  COMPLETED: "Selesai",
  CANCELLED: "Dibatalkan",
};

export default function AdminDashboardPage() {
  const { toast } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const load = useCallback(() => {
    fetch("/api/admin/stats", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: Stats) => {
        setStats(d);
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat statistik. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load, reload]);

  function retry() {
    toast("Memuat ulang data…", "info");
    setLoading(true);
    setError(null);
    setReload((r) => r + 1);
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Dashboard Admin</h1>
          <p>Ringkasan seluruh aktivitas marketplace Mendung Tirta</p>
        </div>
        <button type="button" className="btn btn-sm btn-outline" onClick={retry} disabled={loading}>
          Muat ulang
        </button>
      </div>

      {error && (
        <div className="form-error-banner" role="alert">
          {error}{" "}
          <button type="button" className="btn btn-sm btn-outline" onClick={retry}>
            Coba lagi
          </button>
        </div>
      )}

      {loading && !stats && !error && (
        <div className="dash-loading" aria-busy="true">
          Memuat statistik…
        </div>
      )}

      {!loading && !stats && !error && (
        <div className="dash-empty">
          <strong>Belum ada data</strong>
          Statistik marketplace akan muncul di sini.
        </div>
      )}

      {stats && (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-label">Pengguna</span>
              <span className="stat-value">{stats.users.total}</span>
              <span className="stat-sub">
                {stats.users.byRole.ADMIN ?? 0} admin • {stats.users.byRole.SELLER ?? 0} penjual •{" "}
                {stats.users.byRole.BUYER ?? 0} pembeli
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Toko</span>
              <span className="stat-value">{stats.stores.total}</span>
              <span className="stat-sub">
                {stats.stores.active} aktif
                {stats.stores.inactive > 0 && ` • ${stats.stores.inactive} nonaktif`}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Produk</span>
              <span className="stat-value">{stats.products.total}</span>
              <span className="stat-sub">
                {stats.products.byStatus.AVAILABLE ?? 0} tayang •{" "}
                {stats.products.byStatus.OUT_OF_STOCK ?? 0} habis •{" "}
                {stats.products.byStatus.HIDDEN ?? 0} tersembunyi
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Pesanan</span>
              <span className="stat-value">{stats.orders.total}</span>
              <span className="stat-sub">
                {stats.orders.byStatus.PENDING ?? 0} menunggu •{" "}
                {stats.orders.byStatus.PROCESSING ?? 0} diproses •{" "}
                {stats.orders.byStatus.COMPLETED ?? 0} selesai
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Pendapatan</span>
              <span className="stat-value" style={{ fontSize: "1.25rem" }}>
                {formatRupiah(stats.revenue)}
              </span>
              <span className="stat-sub">dari pesanan diproses s/d selesai</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Ulasan</span>
              <span className="stat-value">⭐ {stats.reviews.average || "—"}</span>
              <span className="stat-sub">{stats.reviews.total} ulasan</span>
            </div>
          </div>

          <section className="dash-panel">
            <h2>Pesanan per Status</h2>
            {stats.orders.total === 0 ? (
              <div className="dash-empty">
                <strong>Belum ada pesanan</strong>
                Pesanan yang masuk akan tampil di sini.
              </div>
            ) : (
              <div className="dash-table-wrap" style={{ border: "none" }}>
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th className="num">Jumlah</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(ORDER_STATUS_LABELS).map((key) => (
                      <tr key={key}>
                        <td>{ORDER_STATUS_LABELS[key]}</td>
                        <td className="num">{stats.orders.byStatus[key] ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { useToast } from "@/components/ui/Toast";
import { formatRupiah } from "@/components/product/ProductCard";

type Stats = {
  store: { id: string; storeName: string; isActive: boolean };
  products: { total: number; active: number; outOfStock: number };
  orders: {
    total: number;
    pending: number;
    processing: number;
    completed: number;
  };
  sales: { revenue: number; soldItems: number };
  rating: { average: number; count: number };
  recentOrders: {
    id: string;
    status: string;
    total: number;
    buyerName: string;
    createdAt: string;
  }[];
};

type Store = {
  id: string;
  storeName: string;
  description: string | null;
  location: string | null;
  image: string | null;
} | null;

export default function SellerDashboardPage() {
  const { toast } = useToast();
  const [stats, setStats] = useState<Stats | null>(null);
  const [store, setStore] = useState<Store | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Form profil toko
  const [storeName, setStoreName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [image, setImage] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    Promise.allSettled([
      fetch("/api/seller/stats", { cache: "no-store" }),
      fetch("/api/seller/store", { cache: "no-store" }),
    ]).then(async ([statsRes, storeRes]) => {
      setError(null);

      if (storeRes.status === "fulfilled" && storeRes.value.ok) {
        const d: { store: Store } = await storeRes.value.json();
        setStore(d.store);
        if (d.store) {
          setStoreName(d.store.storeName);
          setDescription(d.store.description ?? "");
          setLocation(d.store.location ?? "");
          setImage(d.store.image ?? "");
        }
      } else {
        setStore(null);
      }

      if (statsRes.status === "fulfilled" && statsRes.value.ok) {
        setStats((await statsRes.value.json()) as Stats);
      } else {
        const status = statsRes.status === "fulfilled" ? statsRes.value.status : 0;
        if (status === 404) {
          // Belum punya toko — tampilkan form pembuatan toko dulu.
          setStats(null);
        } else {
          setError("Gagal memuat statistik dashboard. Coba lagi.");
        }
      }
    });
  }, []);

  useEffect(() => {
    load();
  }, [load, reload]);

  async function onSaveStore(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/seller/store", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeName,
          description: description || null,
          location: location || null,
          image: image || null,
        }),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setFieldErrors(data.fields);
        setFormError(data.message ?? "Gagal menyimpan toko.");
        return;
      }
      toast("Profil toko tersimpan.");
      setError(null);
      setReload((r) => r + 1);
    } catch {
      setFormError("Tidak dapat terhubung ke server.");
    } finally {
      setSaving(false);
    }
  }

  const isNewStore = store === null;

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Dashboard Penjual</h1>
          <p>{store ? `Kelola toko "${store.storeName}"` : "Buat toko Anda untuk mulai berjualan."}</p>
        </div>
        <Link href="/seller/products" className="btn btn-primary btn-sm">
          + Tambah Produk
        </Link>
      </div>

      {error && (
        <div className="form-error-banner" role="alert">
          {error}{" "}
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => {
              setError(null);
              setReload((r) => r + 1);
            }}
          >
            Coba lagi
          </button>
        </div>
      )}

      {store === undefined && !error && (
        <div className="dash-loading" aria-busy="true">
          Memuat dashboard…
        </div>
      )}

      {store !== undefined && (
        <>
          {stats ? (
            <div className="stat-grid">
              <div className="stat-card">
                <span className="stat-label">Pendapatan</span>
                <span className="stat-value" style={{ fontSize: "1.25rem" }}>
                  {formatRupiah(stats.sales.revenue)}
                </span>
                <span className="stat-sub">{stats.sales.soldItems} item terjual</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Pesanan</span>
                <span className="stat-value">{stats.orders.total}</span>
                <span className="stat-sub">
                  {stats.orders.pending} menunggu • {stats.orders.processing} diproses
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Produk</span>
                <span className="stat-value">{stats.products.total}</span>
                <span className="stat-sub">
                  {stats.products.active} aktif
                  {stats.products.outOfStock > 0 && ` • ${stats.products.outOfStock} habis`}
                </span>
              </div>
              <div className="stat-card">
                <span className="stat-label">Rating Toko</span>
                <span className="stat-value">⭐ {stats.rating.average || "—"}</span>
                <span className="stat-sub">{stats.rating.count} ulasan</span>
              </div>
            </div>
          ) : (
            !error && (
              <div className="dash-empty">
                <strong>{isNewStore ? "Buat toko terlebih dahulu" : "Statistik belum tersedia"}</strong>
                {isNewStore
                  ? "Isi profil toko di bawah ini — setelah tersimpan, dashboard dan produk akan aktif."
                  : "Muat ulang halaman untuk mencoba lagi."}
              </div>
            )
          )}

          {stats && stats.recentOrders.length > 0 && (
            <section className="dash-panel">
              <h2>Pesanan Terbaru</h2>
              <div className="dash-table-wrap" style={{ border: "none" }}>
                <table className="dash-table">
                  <thead>
                    <tr>
                      <th>Pesanan</th>
                      <th>Pembeli</th>
                      <th>Status</th>
                      <th className="num">Total</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentOrders.map((o) => (
                      <tr key={o.id}>
                        <td>#{o.id.slice(0, 8)}</td>
                        <td>{o.buyerName}</td>
                        <td>
                          <StatusBadge status={o.status} />
                        </td>
                        <td className="num">{formatRupiah(o.total)}</td>
                        <td className="num">
                          <Link href="/seller/orders" className="btn btn-sm btn-outline">
                            Kelola
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="dash-panel">
            <h2>{isNewStore ? "Buat Toko" : "Profil Toko"}</h2>
            <form onSubmit={onSaveStore}>
              {formError && (
                <div className="form-error-banner" role="alert">
                  {formError}
                </div>
              )}
              <div className="dash-form-grid">
                <label className="dash-form-field">
                  <span>Nama toko *</span>
                  <input
                    type="text"
                    value={storeName}
                    onChange={(e) => setStoreName(e.target.value)}
                    maxLength={100}
                    required
                  />
                  {fieldErrors.storeName && (
                    <span className="field-error">{fieldErrors.storeName}</span>
                  )}
                </label>
                <label className="dash-form-field">
                  <span>Lokasi</span>
                  <input
                    type="text"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                    maxLength={255}
                    placeholder="mis. Pelabuhan Nusle, Cilacap"
                  />
                  {fieldErrors.location && (
                    <span className="field-error">{fieldErrors.location}</span>
                  )}
                </label>
                <label className="dash-form-field full">
                  <span>Deskripsi</span>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder="Ceritakan singkat tentang toko Anda…"
                  />
                  {fieldErrors.description && (
                    <span className="field-error">{fieldErrors.description}</span>
                  )}
                </label>
                <label className="dash-form-field full">
                  <span>URL foto/logo</span>
                  <input
                    type="url"
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    maxLength={500}
                    placeholder="https://…"
                  />
                  {fieldErrors.image && <span className="field-error">{fieldErrors.image}</span>}
                </label>
              </div>
              <div style={{ marginTop: "1.1rem" }}>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? "Menyimpan…" : isNewStore ? "Buat Toko" : "Simpan Perubahan"}
                </button>
              </div>
            </form>
          </section>
        </>
      )}
    </>
  );
}

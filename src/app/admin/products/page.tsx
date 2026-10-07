"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatRupiah } from "@/lib/format";

type AdminProduct = {
  id: string;
  name: string;
  price: number;
  stock: number;
  image: string | null;
  status: string;
  store: { id: string; storeName: string };
  category: { id: string; name: string };
  reviewCount: number;
  soldCount: number;
  createdAt: string;
};

type ListData = {
  items: AdminProduct[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export default function AdminProductsPage() {
  const { toast } = useToast();

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [hideTarget, setHideTarget] = useState<AdminProduct | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    params.set("page", String(page));
    fetch(`/api/admin/products?${params.toString()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: ListData) => {
        setData(d);
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat produk. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [q, status, page]);

  useEffect(() => {
    load();
  }, [load, reload]);

  async function setStatusFor(product: AdminProduct, next: string) {
    if (busyId) return;
    setBusyId(product.id);
    try {
      const res = await fetch(`/api/admin/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal memperbarui status produk.", "error");
        return;
      }
      toast(
        next === "HIDDEN"
          ? `"${product.name}" disembunyikan dari katalog.`
          : `"${product.name}" ditampilkan kembali.`,
      );
      setHideTarget(null);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Produk</h1>
          <p>{data ? `${data.total} produk di seluruh toko` : "Moderasi produk lintas toko"}</p>
        </div>
      </div>

      <div className="dash-toolbar">
        <input
          type="search"
          placeholder="Cari nama produk…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
            setLoading(true);
            setError(null);
          }}
          aria-label="Cari produk"
        />
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
            setLoading(true);
            setError(null);
          }}
          aria-label="Filter status"
        >
          <option value="">Semua status</option>
          <option value="AVAILABLE">Tayang</option>
          <option value="OUT_OF_STOCK">Habis</option>
          <option value="HIDDEN">Tersembunyi</option>
        </select>
      </div>

      {error && (
        <div className="form-error-banner" role="alert">
          {error}{" "}
          <button
            type="button"
            className="btn btn-sm btn-outline"
            onClick={() => {
              setLoading(true);
              setError(null);
              setReload((r) => r + 1);
            }}
          >
            Coba lagi
          </button>
        </div>
      )}

      {loading && !data && <div className="dash-loading" aria-busy="true">Memuat produk…</div>}

      {data && data.items.length === 0 && !error && (
        <div className="dash-empty">
          <strong>Belum ada produk{q || status ? " yang cocok" : ""}</strong>
          {q || status ? "Coba ubah kata kunci atau filter status." : "Produk dari penjual akan muncul di sini."}
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Produk</th>
                <th>Toko</th>
                <th>Kategori</th>
                <th className="num">Harga</th>
                <th className="num">Stok</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="admin-cell-strong">{p.name}</span>
                    <span className="admin-cell-sub">
                      {p.soldCount} terjual • {p.reviewCount} ulasan
                    </span>
                  </td>
                  <td>{p.store.storeName}</td>
                  <td>{p.category.name}</td>
                  <td className="num">{formatRupiah(p.price)}</td>
                  <td className="num">{p.stock}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td>
                    <div className="dash-actions">
                      {p.status === "HIDDEN" ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-outline"
                          disabled={busyId === p.id}
                          onClick={() => setStatusFor(p, "AVAILABLE")}
                        >
                          {busyId === p.id ? "Memproses…" : "Tampilkan"}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger-outline"
                          disabled={busyId === p.id}
                          onClick={() => setHideTarget(p)}
                        >
                          Sembunyikan
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.totalPages > 1 && (
        <div className="dash-pagination">
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={page <= 1 || loading}
            onClick={() => {
              setPage((p) => p - 1);
              setLoading(true);
              setError(null);
            }}
          >
            ← Sebelumnya
          </button>
          <span className="admin-page-info">
            Halaman {data.page} dari {data.totalPages}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            disabled={page >= data.totalPages || loading}
            onClick={() => {
              setPage((p) => p + 1);
              setLoading(true);
              setError(null);
            }}
          >
            Berikutnya →
          </button>
        </div>
      )}

      <ConfirmModal
        open={hideTarget !== null}
        title="Sembunyikan produk?"
        message={
          hideTarget
            ? `Produk "${hideTarget.name}" (${hideTarget.store.storeName}) akan disembunyikan dari katalog publik. Riwayat pesanan tetap utuh.`
            : ""
        }
        confirmLabel="Ya, sembunyikan"
        busy={busyId !== null}
        onConfirm={() => hideTarget && setStatusFor(hideTarget, "HIDDEN")}
        onCancel={() => setHideTarget(null)}
      />
    </>
  );
}

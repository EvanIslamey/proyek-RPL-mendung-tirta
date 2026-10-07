"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

type AdminStore = {
  id: string;
  storeName: string;
  description: string | null;
  location: string | null;
  isActive: boolean;
  owner: { id: string; name: string; email: string };
  productCount: number;
  createdAt: string;
};

type ListData = {
  items: AdminStore[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export default function AdminStoresPage() {
  const { toast } = useToast();

  const [q, setQ] = useState("");
  const [isActive, setIsActive] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [target, setTarget] = useState<AdminStore | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (isActive) params.set("isActive", isActive);
    params.set("page", String(page));
    fetch(`/api/admin/stores?${params.toString()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: ListData) => {
        setData(d);
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat toko. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [q, isActive, page]);

  useEffect(() => {
    load();
  }, [load, reload]);

  async function confirmToggle() {
    if (!target || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/stores/${target.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !target.isActive }),
      });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal mengubah status toko.", "error");
        return;
      }
      toast(data.message ?? "Status toko diperbarui.");
      setTarget(null);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Toko</h1>
          <p>{data ? `${data.total} toko terdaftar` : "Kelola semua toko penjual"}</p>
        </div>
      </div>

      <div className="dash-toolbar">
        <input
          type="search"
          placeholder="Cari nama toko / pemilik…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
            setLoading(true);
            setError(null);
          }}
          aria-label="Cari toko"
        />
        <select
          value={isActive}
          onChange={(e) => {
            setIsActive(e.target.value);
            setPage(1);
            setLoading(true);
            setError(null);
          }}
          aria-label="Filter status toko"
        >
          <option value="">Semua status</option>
          <option value="true">Aktif</option>
          <option value="false">Nonaktif</option>
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

      {loading && !data && <div className="dash-loading" aria-busy="true">Memuat toko…</div>}

      {data && data.items.length === 0 && !error && (
        <div className="dash-empty">
          <strong>Belum ada toko{q || isActive ? " yang cocok" : ""}</strong>
          {q || isActive
            ? "Coba ubah kata kunci atau filter status."
            : "Toko penjual baru akan muncul di sini."}
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Toko</th>
                <th>Pemilik</th>
                <th>Lokasi</th>
                <th className="num">Produk</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span className="admin-cell-strong">{s.storeName}</span>
                    {s.description && <span className="admin-cell-sub">{s.description}</span>}
                  </td>
                  <td>
                    <span className="admin-cell-strong">{s.owner.name}</span>
                    <span className="admin-cell-sub">{s.owner.email}</span>
                  </td>
                  <td>{s.location ? s.location : <span className="admin-muted">—</span>}</td>
                  <td className="num">{s.productCount}</td>
                  <td>
                    <span className={`role-pill ${s.isActive ? "pill-active" : "pill-inactive"}`}>
                      {s.isActive ? "Aktif" : "Nonaktif"}
                    </span>
                  </td>
                  <td>
                    <div className="dash-actions">
                      <button
                        type="button"
                        className={`btn btn-sm ${s.isActive ? "btn-danger-outline" : "btn-outline"}`}
                        disabled={busy && target?.id === s.id}
                        onClick={() => setTarget(s)}
                      >
                        {s.isActive ? "Nonaktifkan" : "Aktifkan"}
                      </button>
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
        open={target !== null}
        title={target?.isActive ? "Nonaktifkan toko?" : "Aktifkan kembali toko?"}
        message={
          target
            ? target.isActive
              ? `Toko "${target.storeName}" akan dinonaktifkan dan produknya tidak tampil di katalog publik.`
              : `Toko "${target.storeName}" akan diaktifkan kembali dan tampil di katalog.`
            : ""
        }
        confirmLabel={target?.isActive ? "Ya, nonaktifkan" : "Ya, aktifkan"}
        danger={target?.isActive ?? true}
        busy={busy}
        onConfirm={confirmToggle}
        onCancel={() => setTarget(null)}
      />
    </>
  );
}

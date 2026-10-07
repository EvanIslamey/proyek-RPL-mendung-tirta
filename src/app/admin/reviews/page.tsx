"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatDateId } from "@/lib/format";

type AdminReview = {
  id: string;
  rating: number;
  comment: string | null;
  product: { id: string; name: string };
  buyer: { id: string; name: string };
  createdAt: string;
};

type ListData = {
  items: AdminReview[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export default function AdminReviewsPage() {
  const { toast } = useToast();

  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [deleteTarget, setDeleteTarget] = useState<AdminReview | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    fetch(`/api/admin/reviews?${params.toString()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: ListData) => {
        setData(d);
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat ulasan. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [page]);

  useEffect(() => {
    load();
  }, [load, reload]);

  async function onDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/reviews/${deleteTarget.id}`, { method: "DELETE" });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal menghapus ulasan.", "error");
        return;
      }
      toast(data.message ?? "Ulasan dihapus.");
      setDeleteTarget(null);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Ulasan</h1>
          <p>{data ? `${data.total} ulasan produk` : "Moderasi ulasan pembeli"}</p>
        </div>
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

      {loading && !data && <div className="dash-loading" aria-busy="true">Memuat ulasan…</div>}

      {data && data.items.length === 0 && !error && (
        <div className="dash-empty">
          <strong>Belum ada ulasan</strong>
          Ulasan dari pembeli akan muncul di sini.
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Produk</th>
                <th>Pembeli</th>
                <th>Rating</th>
                <th>Komentar</th>
                <th>Tanggal</th>
                <th style={{ textAlign: "right" }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.product.name}</strong>
                  </td>
                  <td>{r.buyer.name}</td>
                  <td>
                    <span className="admin-stars" aria-label={`${r.rating} dari 5`}>
                      {"★".repeat(r.rating)}
                      {"☆".repeat(Math.max(0, 5 - r.rating))}
                    </span>
                  </td>
                  <td>
                    {r.comment ? (
                      <span className="admin-comment" title={r.comment}>
                        {r.comment}
                      </span>
                    ) : (
                      <span className="admin-muted">Tanpa komentar</span>
                    )}
                  </td>
                  <td>{formatDateId(r.createdAt)}</td>
                  <td>
                    <div className="dash-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-outline"
                        onClick={() => setDeleteTarget(r)}
                      >
                        Hapus
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
        open={deleteTarget !== null}
        title="Hapus ulasan?"
        message={
          deleteTarget
            ? `Ulasan "${deleteTarget.product.name}" oleh ${deleteTarget.buyer.name} akan dihapus permanen.`
            : ""
        }
        confirmLabel="Ya, hapus"
        busy={deleting}
        onConfirm={onDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

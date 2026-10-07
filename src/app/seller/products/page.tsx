"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Modal, ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatRupiah } from "@/components/product/ProductCard";

type SellerProduct = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  stock: number;
  image: string | null;
  status: string;
  category: { id: string; name: string };
  soldCount: number;
  reviewCount: number;
  ratingAverage: number;
  createdAt: string;
};

type Category = { id: string; name: string };

type ListData = {
  items: SellerProduct[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type FormState = {
  id: string | null;
  name: string;
  description: string;
  price: string;
  stock: string;
  image: string;
  categoryId: string;
  status: string;
};

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  description: "",
  price: "",
  stock: "",
  image: "",
  categoryId: "",
  status: "AVAILABLE",
};

export default function SellerProductsPage() {
  const { toast } = useToast();

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListData | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Form tambah/ubah
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Hapus
  const [deleteTarget, setDeleteTarget] = useState<SellerProduct | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    params.set("page", String(page));
    fetch(`/api/seller/products?${params.toString()}`, { cache: "no-store" })
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

  useEffect(() => {
    fetch("/api/categories")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { categories?: Category[] } | null) => {
        if (d?.categories) setCategories(d.categories);
      })
      .catch(() => undefined);
  }, []);

  function openAdd() {
    setForm({
      ...EMPTY_FORM,
      categoryId: categories[0]?.id ?? "",
    });
    setFormError(null);
    setFieldErrors({});
    setFormOpen(true);
  }

  function openEdit(p: SellerProduct) {
    setForm({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      price: String(p.price),
      stock: String(p.stock),
      image: p.image ?? "",
      categoryId: p.category.id,
      status: p.status,
    });
    setFormError(null);
    setFieldErrors({});
    setFormOpen(true);
  }

  async function onSubmitForm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const payload = {
        name: form.name,
        description: form.description || null,
        price: Number(form.price),
        stock: Number(form.stock),
        image: form.image || null,
        categoryId: form.categoryId,
        status: form.status,
      };
      const isEdit = form.id !== null;
      const res = await fetch(isEdit ? `/api/seller/products/${form.id}` : "/api/seller/products", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setFieldErrors(data.fields);
        setFormError(data.message ?? "Gagal menyimpan produk.");
        return;
      }
      toast(isEdit ? "Produk diperbarui." : "Produk ditambahkan.");
      setFormOpen(false);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    } catch {
      setFormError("Tidak dapat terhubung ke server.");
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/seller/products/${deleteTarget.id}`, { method: "DELETE" });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal menghapus produk.", "error");
        return;
      }
      toast(data.message ?? "Produk dihapus.");
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
          <h1>Kelola Produk</h1>
          <p>{data ? `${data.total} produk di toko Anda` : "Produk toko Anda"}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openAdd}>
          + Tambah Produk
        </button>
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
          <option value="AVAILABLE">Aktif</option>
          <option value="OUT_OF_STOCK">Habis</option>
          <option value="HIDDEN">Disembunyikan</option>
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
          <strong>Belum ada produk</strong>
          {q || status
            ? "Tidak ada produk yang cocok dengan pencarian/filter."
            : "Tambahkan produk pertama Anda untuk mulai berjualan."}
          {!q && !status && (
            <div style={{ marginTop: "1rem" }}>
              <button type="button" className="btn btn-primary" onClick={openAdd}>
                + Tambah Produk
              </button>
            </div>
          )}
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Produk</th>
                <th>Kategori</th>
                <th className="num">Harga</th>
                <th className="num">Stok</th>
                <th>Status</th>
                <th className="num">Terjual</th>
                <th className="num">Rating</th>
                <th style={{ textAlign: "right" }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.name}</strong>
                  </td>
                  <td>{p.category.name}</td>
                  <td className="num">{formatRupiah(p.price)}</td>
                  <td className="num">{p.stock}</td>
                  <td>
                    <StatusBadge status={p.status} />
                  </td>
                  <td className="num">{p.soldCount}</td>
                  <td className="num">{p.ratingAverage > 0 ? `⭐ ${p.ratingAverage}` : "—"}</td>
                  <td>
                    <div className="dash-actions">
                      <button type="button" className="btn btn-sm btn-outline" onClick={() => openEdit(p)}>
                        Ubah
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-outline"
                        onClick={() => setDeleteTarget(p)}
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
          <span className="pagination-info">
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

      {/* Modal tambah/ubah produk */}
      <Modal
        open={formOpen}
        title={form.id ? "Ubah Produk" : "Tambah Produk"}
        onClose={() => setFormOpen(false)}
      >
        <form onSubmit={onSubmitForm} className="modal-body">
          {formError && (
            <div className="form-error-banner" role="alert">
              {formError}
            </div>
          )}
          <div className="dash-form-grid">
            <label className="dash-form-field full">
              <span>Nama produk *</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={150}
                required
              />
              {fieldErrors.name && <span className="field-error">{fieldErrors.name}</span>}
            </label>
            <label className="dash-form-field">
              <span>Kategori *</span>
              <select
                value={form.categoryId}
                onChange={(e) => setForm((f) => ({ ...f, categoryId: e.target.value }))}
                required
              >
                <option value="">Pilih kategori…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {fieldErrors.categoryId && <span className="field-error">{fieldErrors.categoryId}</span>}
            </label>
            <label className="dash-form-field">
              <span>Status *</span>
              <select
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
              >
                <option value="AVAILABLE">Aktif</option>
                <option value="OUT_OF_STOCK">Habis</option>
                <option value="HIDDEN">Disembunyikan</option>
              </select>
              {fieldErrors.status && <span className="field-error">{fieldErrors.status}</span>}
            </label>
            <label className="dash-form-field">
              <span>Harga (Rp) *</span>
              <input
                type="number"
                min={0}
                step={1000}
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                required
              />
              {fieldErrors.price && <span className="field-error">{fieldErrors.price}</span>}
            </label>
            <label className="dash-form-field">
              <span>Stok *</span>
              <input
                type="number"
                min={0}
                step={1}
                value={form.stock}
                onChange={(e) => setForm((f) => ({ ...f, stock: e.target.value }))}
                required
              />
              {fieldErrors.stock && <span className="field-error">{fieldErrors.stock}</span>}
            </label>
            <label className="dash-form-field full">
              <span>URL foto</span>
              <input
                type="url"
                value={form.image}
                onChange={(e) => setForm((f) => ({ ...f, image: e.target.value }))}
                maxLength={500}
                placeholder="https://…"
              />
              {fieldErrors.image && <span className="field-error">{fieldErrors.image}</span>}
            </label>
            <label className="dash-form-field full">
              <span>Deskripsi</span>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                maxLength={2000}
                rows={4}
              />
              {fieldErrors.description && (
                <span className="field-error">{fieldErrors.description}</span>
              )}
            </label>
          </div>
          <div className="modal-actions" style={{ marginTop: "1.25rem" }}>
            <button
              type="button"
              className="btn modal-cancel"
              onClick={() => setFormOpen(false)}
              disabled={saving}
            >
              Batal
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Menyimpan…" : form.id ? "Simpan Perubahan" : "Tambah Produk"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Konfirmasi hapus */}
      <ConfirmModal
        open={deleteTarget !== null}
        title="Hapus produk?"
        message={
          deleteTarget
            ? `Produk "${deleteTarget.name}" akan dihapus permanen. Jika produk pernah dipesan, ia hanya akan disembunyikan agar riwayat pesanan tetap utuh.`
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

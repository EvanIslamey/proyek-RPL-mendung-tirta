"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal, ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

type AdminCategory = {
  id: string;
  name: string;
  description: string | null;
  productCount: number;
};

type ListData = { items: AdminCategory[]; total: number };

type FormState = { id: string | null; name: string; description: string };

const EMPTY_FORM: FormState = { id: null, name: "", description: "" };

export default function AdminCategoriesPage() {
  const { toast } = useToast();

  const [data, setData] = useState<ListData | null>(null);
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
  const [deleteTarget, setDeleteTarget] = useState<AdminCategory | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    fetch("/api/admin/categories", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: ListData) => {
        setData(d);
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat kategori. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load, reload]);

  function openAdd() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setFieldErrors({});
    setFormOpen(true);
  }

  function openEdit(c: AdminCategory) {
    setForm({ id: c.id, name: c.name, description: c.description ?? "" });
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
      const isEdit = form.id !== null;
      const res = await fetch(isEdit ? `/api/admin/categories/${form.id}` : "/api/admin/categories", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, description: form.description || null }),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setFieldErrors(data.fields);
        setFormError(data.message ?? "Gagal menyimpan kategori.");
        return;
      }
      toast(isEdit ? "Kategori diperbarui." : "Kategori ditambahkan.");
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
      const res = await fetch(`/api/admin/categories/${deleteTarget.id}`, { method: "DELETE" });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Pesan 409 (masih dipakai N produk) ikut ditampilkan.
        toast(data.message ?? "Gagal menghapus kategori.", "error");
        return;
      }
      toast(data.message ?? "Kategori dihapus.");
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
          <h1>Kategori</h1>
          <p>{data ? `${data.total} kategori` : "Kelola kategori produk"}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openAdd}>
          + Tambah Kategori
        </button>
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

      {loading && !data && <div className="dash-loading" aria-busy="true">Memuat kategori…</div>}

      {data && data.items.length === 0 && !error && (
        <div className="dash-empty">
          <strong>Belum ada kategori</strong>
          Buat kategori pertama agar penjual bisa mengelompokkan produknya.
          <div style={{ marginTop: "1rem" }}>
            <button type="button" className="btn btn-primary" onClick={openAdd}>
              + Tambah Kategori
            </button>
          </div>
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Nama</th>
                <th>Deskripsi</th>
                <th className="num">Produk</th>
                <th style={{ textAlign: "right" }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong>
                  </td>
                  <td>
                    {c.description ? (
                      c.description
                    ) : (
                      <span className="admin-muted">Tanpa deskripsi</span>
                    )}
                  </td>
                  <td className="num">{c.productCount}</td>
                  <td>
                    <div className="dash-actions">
                      <button
                        type="button"
                        className="btn btn-sm btn-outline"
                        onClick={() => openEdit(c)}
                      >
                        Ubah
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger-outline"
                        onClick={() => setDeleteTarget(c)}
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

      {/* Modal tambah/ubah kategori */}
      <Modal
        open={formOpen}
        title={form.id ? "Ubah Kategori" : "Tambah Kategori"}
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
              <span>Nama kategori *</span>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={60}
                required
              />
              {fieldErrors.name && <span className="field-error">{fieldErrors.name}</span>}
            </label>
            <label className="dash-form-field full">
              <span>Deskripsi</span>
              <textarea
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                maxLength={200}
                rows={3}
                placeholder="Opsional, maksimal 200 karakter…"
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
              {saving ? "Menyimpan…" : form.id ? "Simpan Perubahan" : "Tambah Kategori"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Konfirmasi hapus */}
      <ConfirmModal
        open={deleteTarget !== null}
        title="Hapus kategori?"
        message={
          deleteTarget
            ? deleteTarget.productCount > 0
              ? `Kategori "${deleteTarget.name}" masih dipakai ${deleteTarget.productCount} produk dan tidak bisa dihapus sampai produknya dipindah.`
              : `Kategori "${deleteTarget.name}" akan dihapus permanen.`
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

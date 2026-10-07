"use client";

import { useCallback, useEffect, useState } from "react";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

type AdminUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  address: string | null;
  isActive: boolean;
  createdAt: string;
  orderCount: number;
};

type ListData = {
  items: AdminUser[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const ROLES = ["ADMIN", "SELLER", "BUYER"] as const;

const ROLE_LABEL: Record<string, string> = {
  ADMIN: "Admin",
  SELLER: "Penjual",
  BUYER: "Pembeli",
};

export default function AdminUsersPage() {
  const { toast } = useToast();

  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Id akun sendiri — tidak boleh bisa diubah dari halaman ini.
  const [selfId, setSelfId] = useState<string | null>(null);

  const [pendingRole, setPendingRole] = useState<{ user: AdminUser; nextRole: string } | null>(null);
  const [pendingToggle, setPendingToggle] = useState<AdminUser | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (role) params.set("role", role);
    params.set("page", String(page));
    fetch(`/api/admin/users?${params.toString()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: ListData) => {
        setData(d);
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat pengguna. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [q, role, page]);

  useEffect(() => {
    load();
  }, [load, reload]);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { user?: { id: string } | null } | null) => setSelfId(d?.user?.id ?? null))
      .catch(() => setSelfId(null));
  }, []);

  /** PATCH generik ke /api/admin/users/[id]. */
  async function patchUser(id: string, payload: Record<string, unknown>): Promise<boolean> {
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal memperbarui pengguna.", "error");
        return false;
      }
      toast(data.message ?? "Pengguna diperbarui.");
      return true;
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
      return false;
    }
  }

  async function confirmRole() {
    if (!pendingRole || busyId) return;
    setBusyId(pendingRole.user.id);
    const ok = await patchUser(pendingRole.user.id, { role: pendingRole.nextRole });
    setBusyId(null);
    if (ok) {
      setPendingRole(null);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    }
  }

  async function confirmToggle() {
    if (!pendingToggle || busyId) return;
    setBusyId(pendingToggle.id);
    const ok = await patchUser(pendingToggle.id, { isActive: !pendingToggle.isActive });
    setBusyId(null);
    if (ok) {
      setPendingToggle(null);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    }
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Pengguna</h1>
          <p>{data ? `${data.total} terdaftar` : "Kelola akun pengguna marketplace"}</p>
        </div>
      </div>

      <div className="dash-toolbar">
        <input
          type="search"
          placeholder="Cari nama atau email…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
            setLoading(true);
            setError(null);
          }}
          aria-label="Cari pengguna"
        />
        <select
          value={role}
          onChange={(e) => {
            setRole(e.target.value);
            setPage(1);
            setLoading(true);
            setError(null);
          }}
          aria-label="Filter peran"
        >
          <option value="">Semua peran</option>
          <option value="ADMIN">Admin</option>
          <option value="SELLER">Penjual</option>
          <option value="BUYER">Pembeli</option>
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

      {loading && !data && <div className="dash-loading" aria-busy="true">Memuat pengguna…</div>}

      {data && data.items.length === 0 && !error && (
        <div className="dash-empty">
          <strong>Belum ada pengguna{q || role ? " yang cocok" : ""}</strong>
          {q || role ? "Coba ubah kata kunci atau filter peran." : "Pengguna baru akan muncul di sini."}
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="dash-table-wrap">
          <table className="dash-table">
            <thead>
              <tr>
                <th>Pengguna</th>
                <th>Peran</th>
                <th>Status</th>
                <th className="num">Pesanan</th>
                <th style={{ textAlign: "right" }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((u) => {
                const isSelf = u.id === selfId;
                return (
                  <tr key={u.id}>
                    <td>
                      <span className="admin-cell-strong">{u.name}</span>
                      <span className="admin-cell-sub">{u.email}</span>
                    </td>
                    <td>
                      {isSelf ? (
                        <>
                          <span className={`role-pill role-${u.role.toLowerCase()}`}>
                            {ROLE_LABEL[u.role] ?? u.role}
                          </span>{" "}
                          <span className="admin-cell-sub">(Anda)</span>
                        </>
                      ) : (
                        <select
                          value={u.role}
                          aria-label={`Ubah peran ${u.name}`}
                          onChange={(e) => {
                            const nextRole = e.target.value;
                            if (nextRole === u.role) return;
                            setPendingRole({ user: u, nextRole });
                          }}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      <span className={`role-pill ${u.isActive ? "pill-active" : "pill-inactive"}`}>
                        {u.isActive ? "Aktif" : "Nonaktif"}
                      </span>
                    </td>
                    <td className="num">{u.orderCount}</td>
                    <td>
                      <div className="dash-actions">
                        {isSelf ? (
                          <span className="admin-muted">Akun sendiri</span>
                        ) : (
                          <button
                            type="button"
                            className={`btn btn-sm ${u.isActive ? "btn-danger-outline" : "btn-outline"}`}
                            disabled={busyId === u.id}
                            onClick={() => setPendingToggle(u)}
                          >
                            {u.isActive ? "Nonaktifkan" : "Aktifkan"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
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

      {/* Konfirmasi ubah peran */}
      <ConfirmModal
        open={pendingRole !== null}
        title="Ubah peran pengguna?"
        message={
          pendingRole
            ? `Peran "${pendingRole.user.name}" akan diubah menjadi ${
                ROLE_LABEL[pendingRole.nextRole] ?? pendingRole.nextRole
              }. Toko yang sudah dimiliki (bila ada) tidak dihapus.`
            : ""
        }
        confirmLabel="Ya, ubah peran"
        danger={false}
        busy={busyId !== null}
        onConfirm={confirmRole}
        onCancel={() => setPendingRole(null)}
      />

      {/* Konfirmasi aktif/nonaktif akun */}
      <ConfirmModal
        open={pendingToggle !== null}
        title={pendingToggle?.isActive ? "Nonaktifkan akun?" : "Aktifkan kembali akun?"}
        message={
          pendingToggle
            ? pendingToggle.isActive
              ? `Akun "${pendingToggle.name}" (${pendingToggle.email}) akan dinonaktifkan dan sesinya langsung dicabut.`
              : `Akun "${pendingToggle.name}" (${pendingToggle.email}) akan diaktifkan kembali dan bisa masuk.`
            : ""
        }
        confirmLabel={pendingToggle?.isActive ? "Ya, nonaktifkan" : "Ya, aktifkan"}
        danger={pendingToggle?.isActive ?? true}
        busy={busyId !== null}
        onConfirm={confirmToggle}
        onCancel={() => setPendingToggle(null)}
      />
    </>
  );
}

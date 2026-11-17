"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { formatRupiah, formatDateId } from "@/lib/format";
import "../../cart/checkout.css";

type AdminOrder = {
  id: string;
  status: string;
  total: number;
  shippingAddress: string;
  paymentStatus: string | null;
  buyer: { id: string; name: string; email: string };
  createdAt: string;
  items: { productId: string; name: string; storeName: string; quantity: number; price: number }[];
};

type ListData = {
  items: AdminOrder[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

/** Transisi status yang diizinkan (sinkron dengan lib/orders.ts). */
const TRANSITIONS: Record<string, { to: string; label: string; primary: boolean }[]> = {
  PENDING: [
    { to: "PROCESSING", label: "Tandai Diproses", primary: true },
    { to: "CANCELLED", label: "Batalkan", primary: false },
  ],
  PROCESSING: [
    { to: "SHIPPED", label: "Kirim", primary: true },
    { to: "READY_FOR_PICKUP", label: "Siap Diambil", primary: false },
    { to: "CANCELLED", label: "Batalkan", primary: false },
  ],
  SHIPPED: [
    { to: "COMPLETED", label: "Selesai", primary: true },
    { to: "CANCELLED", label: "Batalkan", primary: false },
  ],
  READY_FOR_PICKUP: [
    { to: "COMPLETED", label: "Selesai", primary: true },
    { to: "CANCELLED", label: "Batalkan", primary: false },
  ],
};

const STATUS_TABS = [
  { value: "", label: "Semua" },
  { value: "PENDING", label: "Menunggu Bayar" },
  { value: "PROCESSING", label: "Diproses" },
  { value: "SHIPPED", label: "Dikirim" },
  { value: "READY_FOR_PICKUP", label: "Siap Diambil" },
  { value: "COMPLETED", label: "Selesai" },
  { value: "CANCELLED", label: "Dibatalkan" },
];

export default function AdminOrdersPage() {
  const { toast } = useToast();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<AdminOrder | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    params.set("page", String(page));
    fetch(`/api/admin/orders?${params.toString()}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: ListData) => {
        setData(d);
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat pesanan. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [status, page]);

  useEffect(() => {
    load();
  }, [load, reload]);

  /** Ubah status lewat endpoint PATCH /api/orders/[id] (sudah mengizinkan ADMIN). */
  async function changeStatus(orderId: string, next: string) {
    if (busyId) return;
    setBusyId(orderId);
    try {
      const res = await fetch(`/api/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal memperbarui status.", "error");
        return;
      }
      toast(`Pesanan dipindahkan ke ${next}.`);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function cancelOrder() {
    if (!cancelTarget || cancelling) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/orders/${cancelTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal membatalkan pesanan.", "error");
        return;
      }
      toast("Pesanan dibatalkan & stok dikembalikan.");
      setCancelTarget(null);
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Semua Pesanan</h1>
          <p>{data ? `${data.total} pesanan di seluruh marketplace` : "Pantau & kelola pesanan"}</p>
        </div>
      </div>

      <div className="status-tabs" role="tablist" aria-label="Filter status pesanan">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={status === t.value}
            className={`status-tab${status === t.value ? " active" : ""}`}
            onClick={() => {
              setStatus(t.value);
              setPage(1);
              setLoading(true);
              setError(null);
            }}
          >
            {t.label}
          </button>
        ))}
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

      {loading && !data && <div className="dash-loading" aria-busy="true">Memuat pesanan…</div>}

      {data && data.items.length === 0 && !error && (
        <div className="dash-empty">
          <strong>Belum ada pesanan{status ? " dengan status ini" : ""}</strong>
          Pesanan dari seluruh pembeli akan muncul di sini.
        </div>
      )}

      {data && data.items.length > 0 && (
        <>
          <div style={{ display: "grid", gap: "1rem" }}>
            {data.items.map((o) => (
              <article key={o.id} className="dash-panel" style={{ marginBottom: 0 }}>
                <div className="order-card-head">
                  <div>
                    <strong>#{o.id.slice(0, 8)}</strong>
                    <p className="order-date">
                      {o.buyer.name} ({o.buyer.email}) • {formatDateId(o.createdAt)}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                    {o.paymentStatus && <StatusBadge status={o.paymentStatus} />}
                    <StatusBadge status={o.status} />
                  </div>
                </div>

                <ul className="order-items-mini" style={{ margin: "0.75rem 0" }}>
                  {o.items.map((i) => (
                    <li key={`${o.id}-${i.productId}`}>
                      {i.name} <span className="muted">× {i.quantity}</span>{" "}
                      <span className="muted">({i.storeName})</span>
                    </li>
                  ))}
                </ul>

                <p style={{ fontSize: "0.88rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    style={{ verticalAlign: "-2px", marginRight: "0.35rem" }}
                  >
                    <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
                    <circle cx="12" cy="10" r="2.6" />
                  </svg>
                  {o.shippingAddress}
                </p>

                <div className="order-card-foot">
                  <strong className="order-total">{formatRupiah(o.total)}</strong>
                  <div className="order-actions">
                    {(TRANSITIONS[o.status] ?? []).map((t) =>
                      t.to === "CANCELLED" ? (
                        <button
                          key={t.to}
                          type="button"
                          className="btn btn-sm btn-danger-outline"
                          disabled={busyId === o.id}
                          onClick={() => setCancelTarget(o)}
                        >
                          {t.label}
                        </button>
                      ) : (
                        <button
                          key={t.to}
                          type="button"
                          className={`btn btn-sm ${t.primary ? "btn-primary" : "btn-outline"}`}
                          disabled={busyId === o.id}
                          onClick={() => changeStatus(o.id, t.to)}
                        >
                          {busyId === o.id ? "Memproses…" : t.label}
                        </button>
                      ),
                    )}
                    {(TRANSITIONS[o.status] ?? []).length === 0 && (
                      <span style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
                        Tidak ada aksi tersedia.
                      </span>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>

          {data.totalPages > 1 && (
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
        </>
      )}

      <ConfirmModal
        open={cancelTarget !== null}
        title="Batalkan pesanan?"
        message={
          cancelTarget
            ? `Pesanan #${cancelTarget.id.slice(0, 8)} akan dibatalkan dan stok produk dikembalikan. Tindakan ini tidak dapat dibatalkan.`
            : ""
        }
        confirmLabel="Ya, batalkan pesanan"
        busy={cancelling}
        onConfirm={cancelOrder}
        onCancel={() => setCancelTarget(null)}
      />
    </>
  );
}

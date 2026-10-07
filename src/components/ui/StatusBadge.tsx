/** Badge status pesanan / pembayaran — dipakai halaman orders & dashboard. */

const ORDER_STYLE: Record<string, { label: string; className: string }> = {
  PENDING: { label: "Menunggu Pembayaran", className: "badge-pending" },
  PROCESSING: { label: "Diproses", className: "badge-processing" },
  SHIPPED: { label: "Dikirim", className: "badge-shipped" },
  READY_FOR_PICKUP: { label: "Siap Diambil", className: "badge-ready" },
  COMPLETED: { label: "Selesai", className: "badge-completed" },
  CANCELLED: { label: "Dibatalkan", className: "badge-cancelled" },
  // Payment
  PAID: { label: "Lunas", className: "badge-completed" },
  FAILED: { label: "Gagal", className: "badge-cancelled" },
  // Product
  AVAILABLE: { label: "Aktif", className: "badge-completed" },
  OUT_OF_STOCK: { label: "Habis", className: "badge-pending" },
  HIDDEN: { label: "Disembunyikan", className: "badge-cancelled" },
};

export function StatusBadge({ status }: { status: string }) {
  const cfg = ORDER_STYLE[status] ?? { label: status, className: "badge-processing" };
  return (
    <span className={`status-badge ${cfg.className}`} role="status">
      {cfg.label}
    </span>
  );
}

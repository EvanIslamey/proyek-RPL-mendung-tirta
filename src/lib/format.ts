/**
 * Utilitas format — modul netral (tanpa "use client"), aman dipanggil
 * dari server component maupun client component.
 */

const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

export function formatRupiah(value: number): string {
  return rupiah.format(value);
}

/** Tanggal panjang format Indonesia: "7 Oktober 2026". */
export function formatDateId(value: string | Date): string {
  return new Date(value).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

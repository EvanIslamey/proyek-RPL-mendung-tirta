/**
 * Utilitas tampilan produk (tanpa menambah kolom DB).
 * Satuan diturunkan dari nama produk yang sudah ada, mis. "(1 Kg)" → "per kg".
 */
export function productUnit(name: string): string {
  const lower = name.toLowerCase();

  const weight = lower.match(/\((\d+(?:[.,]\d+)?)\s*(kg|kilogram|gr|gram)\b/);
  if (weight) {
    const value = weight[1].replace(",", ".");
    const unit = weight[2].startsWith("k") ? "kg" : "gr";
    return value === "1" ? `per ${unit}` : `per ${value} ${unit}`;
  }

  const volume = lower.match(/\((\d+(?:[.,]\d+)?)\s*(ml|l|liter)\b/);
  if (volume) {
    const value = volume[1].replace(",", ".");
    return `per ${value} ${volume[2] === "l" || volume[2] === "liter" ? "liter" : "ml"}`;
  }

  const length = lower.match(/\((\d+(?:[.,]\d+)?)\s*(m|meter|cm)\b/);
  if (length) {
    const value = length[1].replace(",", ".");
    return `per ${value} ${length[2]}`;
  }

  if (/\(isi\s*\d+\)/i.test(name)) return "per pack";
  if (/\(1\s*(pcs|buah|biji|ekor)\)/i.test(name)) return "per buah";

  return "per item";
}

/** Label stok singkat + nada warna untuk badge. */
export function stockInfo(stock: number, status: string): {
  label: string;
  tone: "ready" | "low" | "empty";
} {
  if (stock <= 0 || status === "OUT_OF_STOCK") return { label: "Stok habis", tone: "empty" };
  if (stock <= 5) return { label: `Stok terbatas · ${stock}`, tone: "low" };
  return { label: `Stok ${stock}`, tone: "ready" };
}

"use client";

import Link from "next/link";
import type { ProductListItem } from "@/lib/catalog";
import { formatRupiah } from "@/lib/format";
import "./product-card.css";

// Re-export agar import lama dari komponen ini tetap berfungsi (client-only).
export { formatRupiah };

/** Placeholder gambar: gradasi + ikon kategori bila produk tidak punya foto. */
function categoryEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("laut") || n.includes("ikan")) return "🐟";
  if (n.includes("pancing") || n.includes("joran")) return "🎣";
  if (n.includes("umpan")) return "🪱";
  return "🛒";
}

export function ProductCard({ product }: { product: ProductListItem }) {
  const habis = product.stock <= 0 || product.status === "OUT_OF_STOCK";

  return (
    <Link href={`/products/${product.id}`} className="product-card">
      <div className="product-card-media" aria-hidden="true">
        <span className="product-card-emoji">{categoryEmoji(product.category.name)}</span>
        {habis && <span className="product-card-badge badge-habis">Habis</span>}
      </div>
      <div className="product-card-body">
        <span className="product-card-category">{product.category.name}</span>
        <h3 className="product-card-name">{product.name}</h3>
        <p className="product-card-store">
          📍 {product.store.storeName}
          {product.store.location ? ` • ${product.store.location}` : ""}
        </p>
        <div className="product-card-meta">
          <span className="product-card-price">{formatRupiah(product.price)}</span>
          <span className="product-card-rating" aria-label={`Rating ${product.rating.average} dari ${product.rating.count} ulasan`}>
            ⭐ {product.rating.average > 0 ? product.rating.average : "—"}
            <span className="rating-count">({product.rating.count})</span>
          </span>
        </div>
      </div>
    </Link>
  );
}

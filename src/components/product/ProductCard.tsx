"use client";

import { useState } from "react";
import Link from "next/link";
import type { ProductListItem } from "@/lib/catalog";
import { formatRupiah } from "@/lib/format";
import { productUnit, stockInfo } from "@/lib/product-format";
import { useCart } from "@/components/cart/CartContext";
import { FavoriteButton } from "./FavoriteButton";
import { ProductImage } from "./ProductImage";
import "./product-card.css";

// Re-export agar import lama dari komponen ini tetap berfungsi (client-only).
export { formatRupiah };

function Rating({ average, count }: { average: number; count: number }) {
  if (count === 0) {
    return (
      <span className="product-card-rating product-card-rating-empty">
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
        Belum ada ulasan
      </span>
    );
  }

  return (
    <span className="product-card-rating" aria-label={`Rating ${average} dari 5, ${count} ulasan`}>
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"
          fill="currentColor"
        />
      </svg>
      <strong>{average.toFixed(1)}</strong>
      <span className="product-card-rating-count">({count} ulasan)</span>
    </span>
  );
}

/** Tombol tambah cepat tanpa meninggalkan halaman katalog. */
function QuickAdd({ product, disabled }: { product: ProductListItem; disabled: boolean }) {
  const { addItem } = useCart();
  const [added, setAdded] = useState(false);

  function onClick() {
    if (disabled) return;
    addItem({
      productId: product.id,
      name: product.name,
      price: product.price,
      storeName: product.store.storeName,
      stock: product.stock,
      image: product.image,
    });
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1500);
  }

  return (
    <button
      type="button"
      className={`product-card-add${added ? " is-added" : ""}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={disabled ? `${product.name} stok habis` : `Tambah ${product.name} ke keranjang`}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="10" cy="20" r="1.3" fill="currentColor" />
        <circle cx="18" cy="20" r="1.3" fill="currentColor" />
      </svg>
      <span>{disabled ? "Habis" : added ? "Ditambahkan" : "Tambah"}</span>
    </button>
  );
}

export function ProductCard({ product }: { product: ProductListItem }) {
  const habis = product.stock <= 0 || product.status === "OUT_OF_STOCK";
  const stock = stockInfo(product.stock, product.status);
  const unit = productUnit(product.name);
  const href = `/products/${product.id}`;

  return (
    <article className="product-card">
      <div className="product-card-media">
        <Link href={href} className="product-card-media-link" aria-label={product.name}>
          <ProductImage
            src={product.image}
            alt={product.name}
            category={product.category.name}
            className="product-card-img"
          />
        </Link>

        <span className="product-card-badge product-card-category">{product.category.name}</span>

        <FavoriteButton productId={product.id} productName={product.name} />

        {stock.tone !== "ready" && (
          <span className={`product-card-badge product-card-stock-badge badge-${stock.tone}`}>
            {stock.label}
          </span>
        )}
      </div>

      <div className="product-card-body">
        <span className="product-card-store" title={product.store.storeName}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 9v11h16V9M3 9l1.6-4.5A2 2 0 0 1 6.5 3h11a2 2 0 0 1 1.9 1.5L21 9M3 9h18M9 20v-6h6v6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {product.store.storeName}
        </span>

        <Link href={href} className="product-card-title">
          {product.name}
        </Link>

        <Rating average={product.rating.average} count={product.rating.count} />

        <div className="product-card-price-row">
          <p className="product-card-price">{formatRupiah(product.price)}</p>
          <span className="product-card-unit">{unit}</span>
        </div>

        <div className="product-card-footer">
          <span className={`product-card-stock-text tone-${stock.tone}`}>{stock.label}</span>
          <QuickAdd product={product} disabled={habis} />
        </div>
      </div>
    </article>
  );
}

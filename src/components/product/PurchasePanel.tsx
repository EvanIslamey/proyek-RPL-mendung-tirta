"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/components/cart/CartContext";
import { formatRupiah } from "@/lib/format";
import { FavoriteButton } from "./FavoriteButton";

type Props = {
  product: {
    id: string;
    name: string;
    price: number;
    storeName: string;
    stock: number;
    image: string | null;
  };
  disabled?: boolean;
};

/**
 * Panel pembelian detail produk: pilih jumlah, tambah ke keranjang,
 * atau langsung lanjut ke checkout. Semua perhitungan akhir tetap di server.
 */
export function PurchasePanel({ product, disabled }: Props) {
  const { addItem } = useCart();
  const router = useRouter();
  const maxQty = Math.max(1, product.stock);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  const cartPayload = {
    productId: product.id,
    name: product.name,
    price: product.price,
    storeName: product.storeName,
    stock: product.stock,
    image: product.image,
  };

  function clamp(next: number) {
    return Math.min(Math.max(1, next), maxQty);
  }

  function onAdd() {
    if (disabled) return;
    addItem(cartPayload, qty);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1800);
  }

  function onBuyNow() {
    if (disabled) return;
    addItem(cartPayload, qty);
    router.push("/cart");
  }

  return (
    <div className="purchase-panel">
      <div className="purchase-row">
        <span className="purchase-label">Jumlah</span>
        <div className="qty-stepper" aria-label="Pilih jumlah pembelian">
          <button
            type="button"
            onClick={() => setQty((q) => clamp(q - 1))}
            disabled={disabled || qty <= 1}
            aria-label="Kurangi jumlah"
          >
            −
          </button>
          <input
            type="number"
            min={1}
            max={maxQty}
            value={qty}
            onChange={(e) => setQty(clamp(Number.parseInt(e.target.value, 10) || 1))}
            aria-label="Jumlah"
          />
          <button
            type="button"
            onClick={() => setQty((q) => clamp(q + 1))}
            disabled={disabled || qty >= maxQty}
            aria-label="Tambah jumlah"
          >
            +
          </button>
        </div>
        <span className="purchase-subtotal">
          Subtotal <strong>{formatRupiah(product.price * qty)}</strong>
        </span>
      </div>

      <div className="purchase-actions">
        <button
          type="button"
          className="btn btn-primary purchase-add"
          onClick={onAdd}
          disabled={disabled}
        >
          {disabled ? "Stok Habis" : added ? "✓ Masuk keranjang" : "Tambah ke Keranjang"}
        </button>
        <button
          type="button"
          className="btn btn-accent purchase-buy"
          onClick={onBuyNow}
          disabled={disabled}
        >
          Beli Sekarang
        </button>
      </div>

      <FavoriteButton productId={product.id} productName={product.name} variant="wide" />

      <p className="purchase-note">
        {disabled
          ? "Produk ini sedang tidak tersedia. Coba produk serupa di bawah."
          : "Jumlah dan stok akan dikonfirmasi ulang oleh server saat checkout."}
      </p>
    </div>
  );
}

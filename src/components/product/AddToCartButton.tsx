"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useCart } from "@/components/cart/CartContext";

type Props = {
  product: {
    productId: string;
    name: string;
    price: number;
    storeName: string;
    stock: number;
    image: string | null;
  };
  disabled?: boolean;
};

/** Tombol "Masukkan Keranjang" dengan feedback sukses singkat. */
export function AddToCartButton({ product, disabled }: Props) {
  const { addItem } = useCart();
  const router = useRouter();
  const [added, setAdded] = useState(false);

  function onAdd() {
    if (disabled) return;
    addItem(product);
    setAdded(true);
    window.setTimeout(() => setAdded(false), 1600);
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-primary detail-add-btn"
        onClick={onAdd}
        disabled={disabled}
      >
        {disabled ? "Stok Habis" : added ? "✓ Ditambahkan" : "Masukkan Keranjang"}
      </button>
      <button
        type="button"
        className="btn btn-accent detail-buy-btn"
        onClick={() => {
          if (disabled) return;
          addItem(product);
          router.push("/cart");
        }}
        disabled={disabled}
      >
        Beli Sekarang
      </button>
    </>
  );
}

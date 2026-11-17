"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "mt-favorites";

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Event global agar semua tombol favorit (kartu/detail) tetap sinkron. */
const EVENT = "mt-favorites-changed";

function notify() {
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Tombol favorit berbasis localStorage — tidak menambah tabel/endpoint baru.
 * Favorit bersifat lokal per browser, jadi tetap aman untuk pengguna anonim.
 */
export function FavoriteButton({
  productId,
  productName,
  variant = "icon",
}: {
  productId: string;
  productName: string;
  variant?: "icon" | "wide";
}) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const update = () => setActive(readFavorites().includes(productId));
    // Baca storage setelah mount (hindari setState sinkron di effect).
    Promise.resolve().then(update);
    window.addEventListener(EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [productId]);

  function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const current = readFavorites();
    const next = current.includes(productId)
      ? current.filter((id) => id !== productId)
      : [...current, productId];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage penuh/diblokir → abaikan */
    }
    setActive(next.includes(productId));
    notify();
  }

  return (
    <button
      type="button"
      className={`favorite-btn favorite-btn-${variant}${active ? " is-active" : ""}`}
      aria-pressed={active}
      aria-label={active ? `Hapus ${productName} dari favorit` : `Simpan ${productName} ke favorit`}
      title={active ? "Hapus dari favorit" : "Simpan ke favorit"}
      onClick={toggle}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 20.5s-7.5-4.7-7.5-10A4.5 4.5 0 0 1 12 7.2a4.5 4.5 0 0 1 7.5 3.3c0 5.3-7.5 10-7.5 10Z"
          fill={active ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      {variant === "wide" && <span>{active ? "Tersimpan di favorit" : "Simpan ke favorit"}</span>}
    </button>
  );
}

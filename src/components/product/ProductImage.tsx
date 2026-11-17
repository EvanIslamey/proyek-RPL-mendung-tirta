"use client";

import { useState } from "react";

type Props = {
  src: string | null | undefined;
  alt: string;
  /** Ukuran/posisi diatur oleh parent lewat class ini. */
  className?: string;
  /** true untuk gambar utama (eager + prioritas), false untuk kartu (lazy). */
  priority?: boolean;
  category?: string;
};

/** Placeholder SVG sederhana (bukan emoji) saat foto tidak ada/gagal dimuat. */
function MediaPlaceholder({ category }: { category?: string }) {
  const isSeafood = (category ?? "").toLowerCase().includes("laut");
  return (
    <span className="product-media-fallback" role="img" aria-label="Foto produk belum tersedia">
      <svg width="52" height="52" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        {isSeafood ? (
          <>
            <path
              d="M6 24c5-7 11-10 18-10 6 0 11 3 15 8l3 2-3 2c-4 5-9 8-15 8-7 0-13-3-18-10Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path d="M39 24l5-6v12l-5-6Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <circle cx="17" cy="22" r="1.8" fill="currentColor" />
          </>
        ) : (
          <>
            <path
              d="M8 34c7-2 13-6 19-14 4-5 8-7 13-7"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <circle cx="15" cy="33" r="7" stroke="currentColor" strokeWidth="2" />
            <circle cx="15" cy="33" r="2.4" stroke="currentColor" strokeWidth="2" />
            <path d="M32 12l6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </>
        )}
      </svg>
      <span className="product-media-fallback-text">Foto belum tersedia</span>
    </span>
  );
}

/**
 * Foto produk dengan fallback jujur: bila URL kosong atau gagal dimuat,
 * tampilkan placeholder — tidak pernah memakai gambar produk lain.
 */
export function ProductImage({ src, alt, className, priority = false, category }: Props) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span className={`product-media${className ? ` ${className}` : ""}`}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- aset lokal sudah dioptimalkan & butuh onError fallback
        <img
          src={src ?? ""}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <MediaPlaceholder category={category} />
      )}
    </span>
  );
}

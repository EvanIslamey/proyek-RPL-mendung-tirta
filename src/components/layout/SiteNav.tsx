"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthNav } from "./AuthNav";
import { useCart } from "@/components/cart/CartContext";
import "./site-nav.css";

/**
 * Navbar halaman marketplace (katalog, detail, dst).
 * Berbeda dengan navbar landing (home.css), komponen ini dipakai lintas halaman.
 * Mobile: menu disembunyikan di balik tombol hamburger (bukan hilang total).
 */
export function SiteNav() {
  const { totalCount } = useCart();
  const [open, setOpen] = useState(false);

  return (
    <header className="site-navbar">
      <div className="container site-nav-content">
        <Link href="/" className="site-logo" onClick={() => setOpen(false)}>
          Mendung <span>Tirta</span>
        </Link>
        <button
          type="button"
          className="site-nav-burger"
          aria-label={open ? "Tutup menu navigasi" : "Buka menu navigasi"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "✕" : "☰"}
        </button>
        <nav
          className={`site-nav-links${open ? " open" : ""}`}
          aria-label="Navigasi utama"
          onClick={() => setOpen(false)}
        >
          <Link href="/products">Katalog</Link>
          <Link href="/#features">Layanan</Link>
          <Link href="/#about">Tentang Kami</Link>
          <Link href="/cart" className="site-cart-link" aria-label={`Keranjang, ${totalCount} item`}>
            🛒
            {totalCount > 0 && <span className="site-cart-badge">{totalCount}</span>}
          </Link>
          <AuthNav />
        </nav>
      </div>
    </header>
  );
}

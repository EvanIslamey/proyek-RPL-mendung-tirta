"use client";

import { useState } from "react";
import Link from "next/link";
import { AuthNav } from "./AuthNav";
import { DashboardLink } from "./DashboardLink";
import { useCart } from "@/components/cart/CartContext";
import { NotificationBell } from "@/components/notifications/NotificationBell";
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
        <Link href="/" className="site-logo" onClick={() => setOpen(false)} aria-label="Mendung Tirta — beranda">
          <span className="site-logo-mark" aria-hidden="true">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
              <path
                d="M2.5 9.5c2.2 0 2.2-3 4.4-3s2.2 3 4.4 3 2.2-3 4.4-3 2.2 3 4.4 3"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                opacity="0.55"
              />
              <path
                d="M2.5 15c2.2 0 2.2-3 4.4-3s2.2 3 4.4 3 2.2-3 4.4-3 2.2 3 4.4 3"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
              />
            </svg>
          </span>
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
          <DashboardLink />
          <Link href="/cart" className="site-cart-link" aria-label={`Keranjang, ${totalCount} item`}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="10" cy="20" r="1.4" fill="currentColor" />
              <circle cx="18" cy="20" r="1.4" fill="currentColor" />
            </svg>
            {totalCount > 0 && <span className="site-cart-badge">{totalCount}</span>}
          </Link>
          <NotificationBell />
          <AuthNav />
        </nav>
      </div>
    </header>
  );
}

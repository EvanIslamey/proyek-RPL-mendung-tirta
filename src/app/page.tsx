"use client";

import React, { useState } from "react";
import Link from "next/link";
import "./home.css"; // We will create this specific CSS file for home page
import { AuthNav } from "@/components/layout/AuthNav";
import { DashboardLink } from "@/components/layout/DashboardLink";

export default function Home() {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="home-wrapper">
      {/* Navbar */}
      <header className="navbar">
        <div className="container nav-content">
          <div className="logo">Mendung <span>Tirta</span></div>
          <button
            type="button"
            className="nav-burger"
            aria-label={navOpen ? "Tutup menu navigasi" : "Buka menu navigasi"}
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            {navOpen ? "✕" : "☰"}
          </button>
          <nav
            className={`nav-links${navOpen ? " open" : ""}`}
            onClick={() => setNavOpen(false)}
          >
            <Link href="/products">Katalog</Link>
            <DashboardLink />
            <AuthNav />
          </nav>
        </div>
      </header>

      {/* Hero Section */}
      <main>
        <section className="hero">
          <div className="hero-background"></div>
          <div className="container hero-content">
            <h1 className="animate-fade-up">Dari Laut ke Meja Anda.</h1>
            <p className="hero-subtitle animate-fade-up delay-1">
              Marketplace lokal terpercaya untuk hasil panen ikan segar dan perlengkapan memancing kualitas terbaik di kota Anda.
            </p>
            <div className="hero-actions animate-fade-up delay-2">
              <Link href="/products?kategori=Hasil Laut" className="btn btn-primary">
                Beli Hasil Panen
              </Link>
              <Link href="/products?kategori=Alat Pancing" className="btn btn-accent">
                Cari Alat Pancing
              </Link>
            </div>
          </div>
        </section>

        {/* Tentang Kami */}
        <section id="about" className="about-section">
          <div className="container about-content">
            <h2 className="section-title">Tentang Kami</h2>
            <p>
              <strong>Mendung Tirta</strong> lahir dari kota pinggir laut, menghubungkan nelayan
              dan penjual perlengkapan memancing lokal langsung dengan Anda. Tanpa perantara
              berlebihan — hasil panen segar di pagi hari sampai ke meja Anda, dan perlengkapan
              memancing berkualitas dari toko-toko terpercaya di sekitar dermaga.
            </p>
            <p>
              Setiap transaksi didukung sistem yang andal untuk melindungi penjual maupun pembeli,
              sehingga berbelanja lokal terasa mudah, aman, dan menyenangkan.
            </p>
          </div>
        </section>

        {/* Feature Section Placeholder */}
        <section id="features" className="features-section">
          <div className="container">
            <h2 className="section-title">Mengapa Memilih Mendung Tirta?</h2>
            <div className="features-grid">
              <div className="feature-card">
                <div className="feature-icon">🌊</div>
                <h3>Segar dari Nelayan</h3>
                <p>Langsung dari tangan pertama, memastikan kesegaran kualitas ikan yang Anda beli.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🎣</div>
                <h3>Peralatan Lengkap</h3>
                <p>Tersedia berbagai pilihan alat pancing dari penjual lokal yang terkurasi.</p>
              </div>
              <div className="feature-card">
                <div className="feature-icon">🤝</div>
                <h3>Transaksi Aman</h3>
                <p>Sistem marketplace yang andal untuk melindungi penjual dan pembeli.</p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="container">
          <p>&copy; {new Date().getFullYear()} Mendung Tirta. Hak cipta dilindungi.</p>
        </div>
      </footer>
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dashboardHrefFor, profileHrefFor } from "./account-routes";
import { notifySessionChanged, useSessionUser } from "./use-session-user";

/**
 * Aksi autentikasi di navbar:
 * - Tamu  -> tombol "Masuk" (link ke /login)
 * - Login -> dropdown akun "Informasi Akun" dengan:
 *   Profil Saya, Dashboard, Informasi Akun, Layanan, Tentang Kami,
 *   Pengaturan, Keluar.
 * Sesi diambil lewat hook bersama (useSessionUser) sehingga link Dashboard
 * di navbar dan dropdown ini selalu konsisten.
 */
export function AuthNav() {
  const router = useRouter();
  const user = useSessionUser();
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [menuOpen]);

  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      // Beri tahu semua komponen navbar (AuthNav, DashboardLink) bahwa
      // sesi berakhir — link Dashboard ikut hilang dari navbar.
      notifySessionChanged();
      router.refresh();
    } catch {
      /* biarkan state; pengguna bisa mencoba lagi */
    } finally {
      setLoggingOut(false);
    }
  }

  if (user) {
    const firstName = user.name.split(" ")[0] || user.name;

    return (
      <div className="nav-account" ref={menuRef}>
        <button
          type="button"
          className="nav-account-trigger"
          aria-label={menuOpen ? "Tutup menu akun" : "Buka menu akun"}
          aria-expanded={menuOpen}
          aria-haspopup="true"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="nav-user">Halo, {firstName}</span>
          <span className="nav-arrow" aria-hidden="true">▾</span>
        </button>

        {menuOpen && (
          <div className="nav-account-menu" role="menu">
            <Link
              href={profileHrefFor(user.role)}
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">👤</span>
              <span>Profil Saya</span>
            </Link>
            <Link
              href={dashboardHrefFor(user.role)}
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">📊</span>
              <span>Dashboard</span>
            </Link>
            <Link
              href={profileHrefFor(user.role)}
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">ℹ️</span>
              <span>Informasi Akun</span>
            </Link>
            {/* Layanan & Tentang Kami = section pada halaman publik (tanpa login). */}
            <Link
              href="/#features"
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">🛍️</span>
              <span>Layanan</span>
            </Link>
            <Link
              href="/#about"
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">📖</span>
              <span>Tentang Kami</span>
            </Link>
            <Link
              href={profileHrefFor(user.role)}
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">⚙️</span>
              <span>Pengaturan</span>
            </Link>
            <hr className="nav-account-divider" />
            <button
              type="button"
              className="nav-account-item nav-logout"
              role="menuitem"
              onClick={logout}
              disabled={loggingOut}
            >
              <span className="nav-account-icon" aria-hidden="true">🚪</span>
              <span>{loggingOut ? "…" : "Keluar"}</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Link href="/login" className="btn btn-primary auth-link">
      Masuk
    </Link>
  );
}

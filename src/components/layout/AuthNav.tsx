"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { profileHrefFor } from "./account-routes";
import { notifySessionChanged, useSessionUser } from "./use-session-user";

/**
 * Aksi autentikasi di navbar:
 * - Menu "INFORMASI" (Layanan & Tentang Kami) — TERPISAH dari menu akun,
 *   tersedia untuk tamu maupun yang login (Bagian 6: Informasi tidak
 *   bercampur dengan dashboard/profil pribadi).
 * - Tamu  -> tombol "Masuk" (link ke /login)
 * - Login -> dropdown "Menu akun": Informasi Diri (profil), Keluar.
 *   Dashboard ada di navbar utama (DashboardLink).
 * Sesi diambil lewat hook bersama (useSessionUser) agar konsisten.
 */

/** Ikon garis kecil untuk item menu navbar (seragam, bukan emoji). */
function NavIcon({ name }: { name: "bag" | "book" | "user" | "logout" }) {
  const paths: Record<typeof name, React.ReactNode> = {
    bag: (
      <>
        <path d="M5 8h14l1 12H4L5 8Z" />
        <path d="M9 8V6a3 3 0 0 1 6 0v2" />
      </>
    ),
    book: (
      <>
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" />
        <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H20" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8" r="3.4" />
        <path d="M5.5 20c.8-3.4 3.4-5.3 6.5-5.3s5.7 1.9 6.5 5.3" />
      </>
    ),
    logout: (
      <>
        <path d="M14 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8" />
        <path d="M17 8l4 4-4 4M21 12H10" />
      </>
    ),
  };

  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

/** Dropdown "Informasi" — Layanan & Tentang Kami (section publik beranda). */
function InfoMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div className="nav-account" ref={ref}>
      <button
        type="button"
        className="nav-account-trigger"
        aria-label={open ? "Tutup menu informasi" : "Buka menu informasi"}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
      >
        <span>Informasi</span>
        <span className="nav-arrow" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="nav-account-menu" role="menu">
          <Link
            href="/#features"
            className="nav-account-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <span className="nav-account-icon" aria-hidden="true"><NavIcon name="bag" /></span>
            <span>Layanan</span>
          </Link>
          <Link
            href="/#about"
            className="nav-account-item"
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            <span className="nav-account-icon" aria-hidden="true"><NavIcon name="book" /></span>
            <span>Tentang Kami</span>
          </Link>
        </div>
      )}
    </div>
  );
}

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
      <>
        <InfoMenu />
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
                <span className="nav-account-icon" aria-hidden="true"><NavIcon name="user" /></span>
                <span>Informasi Diri</span>
              </Link>
              {/* Layanan & Tentang Kami pindah ke menu "Informasi" terpisah. */}
              <hr className="nav-account-divider" />
              <button
                type="button"
                className="nav-account-item nav-logout"
                role="menuitem"
                onClick={logout}
                disabled={loggingOut}
              >
                <span className="nav-account-icon" aria-hidden="true"><NavIcon name="logout" /></span>
                <span>{loggingOut ? "…" : "Keluar"}</span>
              </button>
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <InfoMenu />
      <Link href="/login" className="btn btn-primary auth-link">
        Masuk
      </Link>
    </>
  );
}

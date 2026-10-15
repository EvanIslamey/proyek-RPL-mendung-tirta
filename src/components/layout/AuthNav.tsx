"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type SessionUser = { id: string; name: string; role: string };

/**
 * Aksi autentikasi di navbar:
 * - Tamu  -> tombol "Masuk" (link ke /login)
 * - Login -> dropdown akun dengan: Profil Saya, Informasi Akun, Pengaturan, Keluar
 */
export function AuthNav() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d: { user?: SessionUser | null }) => {
        if (alive) setUser(d.user ?? null);
      })
      .catch(() => {
        /* server belum siap — tetap tampilkan keadaan tamu */
      });
    return () => {
      alive = false;
    };
  }, []);

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
      setUser(null);
      router.refresh();
    } catch {
      /* biarkan state; pengguna bisa mencoba lagi */
    } finally {
      setLoggingOut(false);
    }
  }

  // Determine profile route based on role
  function getProfileHref(role: string): string {
    switch (role) {
      case "ADMIN":
        return "/admin/profile";
      case "SELLER":
        return "/seller/profile";
      case "BUYER":
      default:
        return "/buyer";
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
              href={getProfileHref(user.role)}
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">👤</span>
              <span>Profil Saya</span>
            </Link>
            <Link
              href={getProfileHref(user.role)}
              className="nav-account-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              <span className="nav-account-icon" aria-hidden="true">ℹ️</span>
              <span>Informasi Akun</span>
            </Link>
            <Link
              href="/buyer"
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

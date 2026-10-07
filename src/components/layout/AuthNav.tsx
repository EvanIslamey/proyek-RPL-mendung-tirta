"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type SessionUser = { id: string; name: string; role: string };

/**
 * Aksi autentikasi di navbar landing:
 * - Tamu  -> tombol "Masuk" (link ke /login)
 * - Login -> sapaan + tombol "Keluar"
 */
export function AuthNav() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

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

  if (user) {
    const firstName = user.name.split(" ")[0] || user.name;
    return (
      <>
        <span className="nav-user">Halo, {firstName}</span>
        <button type="button" className="btn nav-logout" onClick={logout} disabled={loggingOut}>
          {loggingOut ? "…" : "Keluar"}
        </button>
      </>
    );
  }

  return (
    <Link href="/login" className="btn btn-primary auth-link">
      Masuk
    </Link>
  );
}

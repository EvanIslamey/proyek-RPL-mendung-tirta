"use client";

import { useEffect, useState } from "react";

/**
 * Sesi login untuk komponen navbar (AuthNav, DashboardLink).
 *
 * - Sekali fetch `/api/auth/me` dipakai bersama oleh semua komponen yang
 *   mounted pada saat yang sama (promise di-share lewat variabel module).
 * - Hasil "belum login" TIDAK di-cache, sehingga setelah login komponen
 *   baru yang mount selalu memperoleh data segar.
 * - Setelah logout, pemanggil wajib memanggil `notifySessionChanged()`
 *   agar komponen lain (mis. link Dashboard) ikut hilang dari navbar.
 */
export type SessionUser = { id: string; name: string; role: string };

const SESSION_EVENT = "mendung-tirta:session-changed";
let pending: Promise<SessionUser | null> | null = null;

function loadSession(): Promise<SessionUser | null> {
  if (!pending) {
    pending = fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { user: null }))
      .then((d: { user?: SessionUser | null }) => d.user ?? null)
      .catch(() => null)
      .then((u) => {
        if (!u) pending = null; // belum login → jangan simpan, biar bisa re-fetch
        return u;
      });
  }
  return pending;
}

/** Beri tahu semua komponen navbar bahwa status login berubah. */
export function notifySessionChanged(): void {
  pending = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EVENT));
}

export function useSessionUser(): SessionUser | null {
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      loadSession().then((u) => {
        if (alive) setUser(u);
      });
    };

    refresh();
    window.addEventListener(SESSION_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener(SESSION_EVENT, refresh);
    };
  }, []);

  return user;
}

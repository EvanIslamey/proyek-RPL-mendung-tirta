"use client";

import Link from "next/link";
import { dashboardHrefFor } from "./account-routes";
import { useSessionUser } from "./use-session-user";

/**
 * Link "Dashboard" di navbar — hanya tampil setelah login, tujuan mengikuti
 * role dari sesi login (bukan dari tebakan URL):
 * - ADMIN  → /admin/dashboard
 * - SELLER → /seller/dashboard
 * - BUYER  → /buyer (area akun pembeli)
 * Terlihat di navbar desktop maupun panel menu mobile (ikut .site-nav-links).
 */
export function DashboardLink({ className }: { className?: string }) {
  const user = useSessionUser();
  if (!user) return null;

  return (
    <Link href={dashboardHrefFor(user.role)} className={className} aria-label="Dashboard saya">
      Dashboard
    </Link>
  );
}

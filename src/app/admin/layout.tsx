import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { SiteNav } from "@/components/layout/SiteNav";
import { DashNavLink } from "@/components/layout/DashNavLink";
import "../dashboard.css";
import "./admin.css";

/**
 * Guard server untuk semua halaman /admin/*.
 * Cek sesi asli di DB + role ADMIN — bukan sekadar keberadaan cookie
 * (proxy.ts baru mengecek keberadaan cookie sebagai lapisan awal).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/admin/dashboard");
  if (user.role !== "ADMIN") redirect("/");

  return (
    <div className="market-wrapper">
      <SiteNav />
      <main className="container dash-shell">
        <aside className="dash-sidebar" aria-label="Navigasi panel admin">
          <span className="dash-sidebar-title">Panel Admin</span>
          <DashNavLink href="/admin/dashboard">📊 Dashboard</DashNavLink>
          <DashNavLink href="/admin/profile">👤 Informasi Diri</DashNavLink>
          <DashNavLink href="/admin/integrations">🔌 Pengaturan Integrasi</DashNavLink>
          <DashNavLink href="/admin/users">👥 Pengguna</DashNavLink>
          <DashNavLink href="/admin/stores">🏪 Toko</DashNavLink>
          <DashNavLink href="/admin/categories">🗂 Kategori</DashNavLink>
          <DashNavLink href="/admin/products">📦 Produk</DashNavLink>
          <DashNavLink href="/admin/orders">🧾 Pesanan</DashNavLink>
          <DashNavLink href="/admin/reviews">⭐ Ulasan</DashNavLink>
        </aside>
        <div className="dash-main">{children}</div>
      </main>
    </div>
  );
}

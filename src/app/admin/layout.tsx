import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { SiteNav } from "@/components/layout/SiteNav";
import { DashNavLink } from "@/components/layout/DashNavLink";
import { DashIcon } from "@/components/layout/DashIcon";
import Link from "next/link";
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
          <DashNavLink href="/admin/dashboard"><DashIcon name="dashboard" /> Dashboard</DashNavLink>
          <DashNavLink href="/admin/profile"><DashIcon name="user" /> Informasi Diri</DashNavLink>
          <DashNavLink href="/admin/integrations"><DashIcon name="plug" /> Integrasi</DashNavLink>
          <DashNavLink href="/admin/users"><DashIcon name="users" /> Pengguna</DashNavLink>
          <DashNavLink href="/admin/stores"><DashIcon name="store" /> Toko</DashNavLink>
          <DashNavLink href="/admin/categories"><DashIcon name="folder" /> Kategori</DashNavLink>
          <DashNavLink href="/admin/products"><DashIcon name="box" /> Produk</DashNavLink>
          <DashNavLink href="/admin/orders"><DashIcon name="receipt" /> Pesanan</DashNavLink>
          <DashNavLink href="/admin/reviews"><DashIcon name="star" /> Ulasan</DashNavLink>
          <div className="dash-sidebar-footer">
            <span>{user.name}</span>
            <Link href="/products">Lihat katalog →</Link>
          </div>
        </aside>
        <div className="dash-main">{children}</div>
      </main>
    </div>
  );
}

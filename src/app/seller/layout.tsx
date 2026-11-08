import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { SiteNav } from "@/components/layout/SiteNav";
import { DashNavLink } from "@/components/layout/DashNavLink";
import "../dashboard.css";

/**
 * Guard server untuk semua halaman /seller/*.
 * Cek sesi asli di DB + role SELLER — bukan sekadar keberadaan cookie
 * (proxy.ts baru mengecek keberadaan cookie sebagai lapisan awal).
 */
export default async function SellerLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/seller/dashboard");
  if (user.role !== "SELLER") redirect("/");

  return (
    <div className="market-wrapper">
      <SiteNav />
      <main className="container dash-shell">
        <aside className="dash-sidebar" aria-label="Navigasi dashboard penjual">
          <span className="dash-sidebar-title">Panel Penjual</span>
          <DashNavLink href="/seller/dashboard">📊 Dashboard</DashNavLink>
          <DashNavLink href="/seller/profile">👤 Informasi Diri</DashNavLink>
          <DashNavLink href="/seller/products">📦 Produk</DashNavLink>
          <DashNavLink href="/seller/orders">🧾 Pesanan</DashNavLink>
        </aside>
        <div className="dash-main">{children}</div>
      </main>
    </div>
  );
}

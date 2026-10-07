import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { SiteNav } from "@/components/layout/SiteNav";
import "../dashboard.css";

/**
 * Guard server untuk /buyer/* — hanya pembeli (BUYER) yang boleh masuk.
 * Penjual diarahkan ke panelnya, admin ke panel admin.
 */
export default async function BuyerLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/buyer");
  if (user.role === "SELLER") redirect("/seller/dashboard");
  if (user.role === "ADMIN") redirect("/admin/dashboard");

  return (
    <div className="market-wrapper">
      <SiteNav />
      <main className="container" style={{ paddingTop: "1.75rem", paddingBottom: "3.5rem", flex: 1 }}>
        {children}
      </main>
    </div>
  );
}

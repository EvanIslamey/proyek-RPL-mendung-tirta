"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Link sidebar dashboard dengan state aktif mengikuti path URL. */
export function DashNavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} className={`dash-nav-link${active ? " active" : ""}`}>
      {children}
    </Link>
  );
}

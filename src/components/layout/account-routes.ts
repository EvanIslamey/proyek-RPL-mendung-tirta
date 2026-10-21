/**
 * Route akun berdasar role — dipakai AuthNav (dropdown) dan DashboardLink
 * agar tujuan navigasi selalu sama dan diverifikasi dari sesi login.
 *
 * Route aktual dari repository (jangan menebak):
 * - ADMIN  → /admin/dashboard (admin/layout.tsx + admin/dashboard/page.tsx)
 * - SELLER → /seller/dashboard (seller/layout.tsx + seller/dashboard/page.tsx)
 * - BUYER  → /buyer/dashboard (ringkasan belanja; /buyer = Informasi Diri)
 */
export function dashboardHrefFor(role: string): string {
  switch (role) {
    case "ADMIN":
      return "/admin/dashboard";
    case "SELLER":
      return "/seller/dashboard";
    case "BUYER":
    default:
      return "/buyer/dashboard";
  }
}

/** Halaman profil / Informasi Diri per role (guard ada di layout segmen). */
export function profileHrefFor(role: string): string {
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

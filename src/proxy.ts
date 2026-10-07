import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Proxy (Next 16 — konvensi `middleware` sudah deprecated, diganti `proxy`).
 *
 * Peran: guard KECEPATAN-AWAL — hanya memeriksa keberadaan cookie sesi
 * `mt_session` dan me-redirect/401 lebih dulu. Validasi sesi yang sesungguhnya
 * (hash token di DB, role, kepemilikan resource) tetap dilakukan oleh:
 *   - layout server (/seller, /admin) via getSessionUser + requireRole
 *   - setiap route handler API via requireUser / requireRole
 * Proxy tidak bisa memanggil DB dengan aman (dijalankan terpisah dari kode
 * render), jadi jangan pernah menganggap cek di sini sebagai otorisasi final.
 */

const SESSION_COOKIE = "mt_session";

/** Halaman yang wajib login (redirect ke /login?next=... bila tidak ada cookie). */
const PROTECTED_PAGES = ["/checkout", "/orders", "/buyer", "/seller", "/admin"];

/** API yang wajib login (401 JSON bila tidak ada cookie). */
const PROTECTED_APIS = ["/api/orders", "/api/seller", "/api/admin", "/api/profile", "/api/ai"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = request.cookies.has(SESSION_COOKIE);

  if (PROTECTED_APIS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (!hasSession) {
      return Response.json({ message: "Anda harus masuk terlebih dahulu." }, { status: 401 });
    }
    return NextResponse.next();
  }

  if (PROTECTED_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    if (!hasSession) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/checkout/:path*",
    "/orders/:path*",
    "/buyer/:path*",
    "/seller/:path*",
    "/admin/:path*",
    "/api/orders/:path*",
    "/api/seller/:path*",
    "/api/admin/:path*",
    "/api/profile/:path*",
    "/api/ai/:path*",
  ],
};

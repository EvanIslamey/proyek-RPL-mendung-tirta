import { getSessionUser } from "@/lib/auth";

/**
 * GET /api/auth/me — user yang sedang login (atau null).
 * Selalu 200 agar halaman publik bisa mengecek sesi tanpa error di console.
 */
export async function GET() {
  try {
    const user = await getSessionUser();
    return Response.json({ user });
  } catch (e) {
    console.error("[api/auth/me]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

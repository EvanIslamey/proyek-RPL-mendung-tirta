import { listCategories } from "@/lib/catalog";

/** GET /api/categories — daftar kategori + jumlah produk aktif (publik). */
export async function GET() {
  try {
    const categories = await listCategories();
    return Response.json({ categories });
  } catch (e) {
    console.error("[api/categories]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

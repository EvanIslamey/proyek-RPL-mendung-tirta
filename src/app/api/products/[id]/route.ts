import type { NextRequest } from "next/server";
import { getProductDetail } from "@/lib/catalog";

/** GET /api/products/[id] — detail produk + rating + ulasan (publik). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const product = await getProductDetail(id);
    if (!product) {
      return Response.json({ message: "Produk tidak ditemukan." }, { status: 404 });
    }
    return Response.json(product);
  } catch (e) {
    console.error("[api/products/[id]]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

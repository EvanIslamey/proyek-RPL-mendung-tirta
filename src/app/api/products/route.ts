import type { NextRequest } from "next/server";
import { listProducts, parseProductListParams } from "@/lib/catalog";

/**
 * GET /api/products — daftar produk publik.
 * Query: q, kategori (id/nama), minHarga, maxHarga, tersedia=1,
 *        sort (terbaru|harga-asc|harga-desc|rating|nama), page, limit.
 */
export async function GET(request: NextRequest) {
  try {
    const params = parseProductListParams(request.nextUrl.searchParams);
    const result = await listProducts(params);
    return Response.json(result);
  } catch (e) {
    console.error("[api/products]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

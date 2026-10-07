import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { payOrder } from "@/lib/orders";
import { ApiError, assertSameOrigin } from "@/lib/validate";

/**
 * POST /api/orders/[id]/pay — bayar pesanan (dummy, MVP).
 * Wajib login dan hanya order PENDING milik user yang bisa dibayar.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const { id } = await params;
    const user = await requireUser();
    await payOrder(user, id);
    return Response.json({ message: "Pembayaran berhasil (dummy)." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/orders/pay]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

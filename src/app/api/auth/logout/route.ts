import type { NextRequest } from "next/server";
import { endSession } from "@/lib/auth";
import { ApiError, assertSameOrigin } from "@/lib/validate";

/** POST /api/auth/logout — hapus sesi aktif dan cookie-nya. */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await endSession();
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/auth/logout]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

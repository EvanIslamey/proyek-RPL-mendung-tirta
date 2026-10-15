import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * POST /api/notifikasi/read — tandai notifikasi (maks 50 ids) atau semua
 * (`{ all: true }`) sebagai sudah dibaca. Update dibatasi ke user sesi:
 * id milik user lain tidak akan tersentuh dan tidak diketahui oleh klien.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();

    const body = await parseJsonBody(request);
    const all = body.all === true;
    const rawIds = Array.isArray(body.ids) ? body.ids : [];

    const ids = all
      ? []
      : rawIds
          .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
          .slice(0, 50);

    if (!all && ids.length === 0) {
      throw new ApiError(400, "Berikan ids (maks 50) atau all: true.", {
        ids: "Berikan ids (maks 50) atau all: true.",
      });
    }

    const readAt = new Date();
    const result = await prisma.notification.updateMany({
      where: {
        userId: user.id, // otorisasi di query — bukan sekadar UI
        readAt: null,
        ...(all ? {} : { id: { in: ids } }),
      },
      data: { readAt },
    });

    return Response.json({ updated: result.count });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/notifications] POST", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

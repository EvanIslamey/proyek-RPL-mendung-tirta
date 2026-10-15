import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * PATCH /api/telegram/preferences — update preferensi notifikasi Telegram.
 * Body: { telegramNotify?: boolean }
 */
export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();

    if (!user.telegramChatId) {
      return Response.json({ message: "Akun Telegram belum terhubung." }, { status: 400 });
    }

    const body = await parseJsonBody(request);
    const telegramNotify = body.telegramNotify === true || body.telegramNotify === false ? body.telegramNotify : undefined;

    if (telegramNotify === undefined) {
      return Response.json({ message: "Parameter telegramNotify wajib diisi (boolean)." }, { status: 400 });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { telegramNotify },
    });

    return Response.json({ message: `Notifikasi Telegram ${telegramNotify ? "diaktifkan" : "dinonaktifkan"}.` });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/telegram/preferences]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}
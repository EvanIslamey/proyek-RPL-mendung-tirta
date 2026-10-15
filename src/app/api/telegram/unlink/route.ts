import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin } from "@/lib/validate";

/**
 * POST /api/telegram/unlink — putuskan hubungan akun Telegram.
 * Hanya user yang login & punya telegramChatId yang bisa unlink.
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();

    if (!user.telegramChatId) {
      return Response.json({ message: "Akun Telegram tidak terhubung." }, { status: 400 });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        telegramChatId: null,
        telegramLinkedAt: null,
        telegramNotify: true, // reset ke default
      },
    });

    return Response.json({ message: "Akun Telegram berhasil diputuskan." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/telegram/unlink]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}
import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidIndonesiaMobile } from "@/lib/integrations";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";

/**
 * GET /api/profile — profil user yang login (wajib login).
 * Menyertakan nomor WhatsApp & persetujuan notifikasi WhatsApp milik sendiri.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        address: true,
        phone: true,
        whatsappNotify: true,
        // Status linking Telegram milik sendiri — dipakai panel "Notifikasi
        // Telegram" di Informasi Diri (tanpa ini panel selalu tampil belum
        // terhubung & token baru terus dibuat).
        telegramChatId: true,
        telegramLinkedAt: true,
        telegramNotify: true,
        isActive: true,
        createdAt: true,
        _count: { select: { orders: true } },
      },
    });
    if (!dbUser) throw new ApiError(401, "Sesi tidak valid. Silakan masuk kembali.");

    return Response.json({
      profile: {
        id: dbUser.id,
        name: dbUser.name,
        email: dbUser.email,
        role: dbUser.role,
        address: dbUser.address,
        phone: dbUser.phone,
        whatsappNotify: dbUser.whatsappNotify,
        telegramChatId: dbUser.telegramChatId,
        telegramLinkedAt: dbUser.telegramLinkedAt?.toISOString() ?? null,
        telegramNotify: dbUser.telegramNotify,
        orderCount: dbUser._count.orders,
        createdAt: dbUser.createdAt.toISOString(),
      },
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/profile GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PATCH /api/profile — ubah nama/alamat/nomor WhatsApp/persetujuan notifikasi.
 * Email, role, dan password TIDAK bisa diubah lewat endpoint ini.
 *
 * Invarian notifikasi WhatsApp (divalidasi server, bukan hanya UI):
 * - nomor harus format internasional Indonesia (+628…);
 * - persetujuan (whatsappNotify=true) hanya boleh bila nomor tersedia;
 * - membatalkan nomor otomatis menonaktifkan persetujuan.
 */
export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const body = await parseJsonBody(request);

    const errors: Record<string, string> = {};
    const data: {
      name?: string;
      address?: string | null;
      phone?: string | null;
      whatsappNotify?: boolean;
    } = {};

    if (body.name !== undefined) {
      const name = asTrimmedString(body.name);
      if (name.length < 2 || name.length > 100) {
        errors.name = "Nama harus 2–100 karakter.";
      } else {
        data.name = name;
      }
    }
    if (body.address !== undefined) {
      const raw = body.address;
      const address = raw === null || raw === "" ? null : asTrimmedString(raw);
      if (address !== null && address.length > 255) {
        errors.address = "Alamat maksimal 255 karakter.";
      } else {
        data.address = address;
      }
    }
    if (body.phone !== undefined) {
      const raw = body.phone;
      const phone = raw === null || raw === "" ? null : asTrimmedString(raw);
      if (phone !== null && !isValidIndonesiaMobile(phone)) {
        errors.phone = "Gunakan format nomor internasional Indonesia, mis. +6281234567890.";
      } else {
        data.phone = phone;
        if (phone === null && body.whatsappNotify === undefined) {
          // Nomor dihapus → persetujuan tidak mungkin tetap berlaku.
          data.whatsappNotify = false;
        }
      }
    }
    if (body.whatsappNotify !== undefined) {
      if (typeof body.whatsappNotify !== "boolean") {
        errors.whatsappNotify = "Nilai harus boolean.";
      } else {
        data.whatsappNotify = body.whatsappNotify;
      }
    }

    // Persetujuan aktif mensyaratkan nomor tersedia (baru atau lama).
    if (data.whatsappNotify === true && !data.phone) {
      const cur = await prisma.user.findUnique({
        where: { id: user.id },
        select: { phone: true },
      });
      if (!cur?.phone) {
        errors.whatsappNotify = "Isi nomor WhatsApp dulu sebelum mengaktifkan notifikasi.";
      }
    }

    if (Object.keys(errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", errors);
    }
    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "Tidak ada perubahan yang dikirim.");
    }

    await prisma.user.update({ where: { id: user.id }, data });
    return Response.json({ message: "Profil diperbarui." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/profile PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

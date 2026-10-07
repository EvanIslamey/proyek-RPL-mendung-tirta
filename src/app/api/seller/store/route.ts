import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody, validateStoreInput } from "@/lib/validate";

/**
 * GET /api/seller/store — profil toko milik penjual yang login.
 * `store: null` bila penjual belum punya toko (bisa dibuat via PATCH).
 */
export async function GET() {
  try {
    const user = await requireRole("SELLER");
    const store = await prisma.store.findUnique({ where: { userId: user.id } });
    return Response.json({
      store: store
        ? {
            id: store.id,
            storeName: store.storeName,
            description: store.description,
            location: store.location,
            image: store.image,
            isActive: store.isActive,
            createdAt: store.createdAt.toISOString(),
          }
        : null,
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message }, { status: e.status });
    }
    console.error("[api/seller/store GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PATCH /api/seller/store — buat/update toko milik sendiri.
 * Tidak ada field eksternal yang bisa diubah (userId mengikuti pemilik).
 */
export async function PATCH(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireRole("SELLER");
    const body = await parseJsonBody(request);
    const input = validateStoreInput(body);
    if (Object.keys(input.errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", input.errors);
    }
    if (
      input.storeName === undefined &&
      input.description === undefined &&
      input.location === undefined &&
      input.image === undefined
    ) {
      throw new ApiError(400, "Tidak ada perubahan yang dikirim.");
    }

    const existing = await prisma.store.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });

    const data: Record<string, unknown> = {};
    if (input.storeName !== undefined) data.storeName = input.storeName;
    if (input.description !== undefined) data.description = input.description;
    if (input.location !== undefined) data.location = input.location;
    if (input.image !== undefined) data.image = input.image;

    if (existing) {
      await prisma.store.update({ where: { id: existing.id }, data });
    } else {
      // Penjual tanpa toko (mis. peran diubah admin) — buat baru dengan nama wajib.
      if (input.storeName === undefined) {
        throw new ApiError(400, "Toko belum ada — nama toko wajib diisi.", {
          storeName: "Toko belum ada — nama toko wajib diisi.",
        });
      }
      await prisma.store.create({
        data: {
          userId: user.id,
          storeName: input.storeName,
          description: input.description ?? null,
          location: input.location ?? null,
          image: input.image ?? null,
        },
      });
    }

    return Response.json({ message: "Toko diperbarui." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/seller/store PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

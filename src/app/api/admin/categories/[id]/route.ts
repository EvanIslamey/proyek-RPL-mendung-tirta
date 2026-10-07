import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody, asTrimmedString } from "@/lib/validate";

/** Deteksi pelanggaran constraint Prisma tanpa mengimpor kelas error. */
function isPrismaCode(e: unknown, code: string): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === code;
}

function validateCategory(input: Record<string, unknown>) {
  const errors: Record<string, string> = {};
  const out: { name?: string; description?: string | null; errors: Record<string, string> } = {
    errors,
  };

  if (input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (name.length < 2 || name.length > 60) {
      errors.name = "Nama kategori harus 2–60 karakter.";
    } else {
      out.name = name;
    }
  }

  if (input.description !== undefined) {
    const raw = input.description;
    const description =
      raw === null || raw === undefined || raw === "" ? null : asTrimmedString(raw);
    if (description !== null && description.length > 200) {
      errors.description = "Deskripsi maksimal 200 karakter.";
    } else {
      out.description = description;
    }
  }

  return out;
}

/**
 * PATCH /api/admin/categories/[id] — ubah nama/deskripsi kategori.
 * Nama unik → 400 "Nama kategori sudah dipakai."
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireRole("ADMIN");
    const { id } = await params;

    const body = await parseJsonBody(request);
    const input = validateCategory(body);
    if (Object.keys(input.errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", input.errors);
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (Object.keys(data).length === 0) {
      throw new ApiError(400, "Tidak ada perubahan yang dikirim.");
    }

    const existing = await prisma.category.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw new ApiError(404, "Kategori tidak ditemukan.");

    try {
      await prisma.category.update({ where: { id }, data });
    } catch (e) {
      if (isPrismaCode(e, "P2002")) {
        throw new ApiError(400, "Nama kategori sudah dipakai.", {
          name: "Nama kategori sudah dipakai.",
        });
      }
      throw e;
    }

    return Response.json({ message: "Kategori diperbarui." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/categories PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/categories/[id] — hapus kategori.
 * Kategori yang masih direferensikan produk tidak bisa dihapus (409).
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    await requireRole("ADMIN");
    const { id } = await params;

    const category = await prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!category) throw new ApiError(404, "Kategori tidak ditemukan.");

    if (category._count.products > 0) {
      throw new ApiError(
        409,
        `Kategori masih dipakai ${category._count.products} produk. Pindahkan produknya dulu.`,
      );
    }

    try {
      await prisma.category.delete({ where: { id } });
    } catch (e) {
      // Cadangan bila ada produk yang baru saja mereferensikan kategori
      // (P2003 foreign key / P2014 relation requirement).
      if (isPrismaCode(e, "P2003") || isPrismaCode(e, "P2014")) {
        throw new ApiError(409, "Kategori masih dipakai produk. Pindahkan produknya dulu.");
      }
      throw e;
    }

    return Response.json({ message: "Kategori dihapus." });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/categories DELETE]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

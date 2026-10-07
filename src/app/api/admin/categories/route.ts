import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, asTrimmedString, parseJsonBody } from "@/lib/validate";

/** Validasi nama + deskripsi kategori (dipakai POST maupun PATCH). */
function validateCategory(input: Record<string, unknown>, opts: { partial?: boolean } = {}) {
  const errors: Record<string, string> = {};
  const out: { name?: string; description?: string | null; errors: Record<string, string> } = {
    errors,
  };

  if (!opts.partial || input.name !== undefined) {
    const name = asTrimmedString(input.name);
    if (name.length < 2 || name.length > 60) {
      errors.name = "Nama kategori harus 2–60 karakter.";
    } else {
      out.name = name;
    }
  }

  if (!opts.partial || input.description !== undefined) {
    const raw = input.description;
    const description = raw === null || raw === undefined || raw === "" ? null : asTrimmedString(raw);
    if (description !== null && description.length > 200) {
      errors.description = "Deskripsi maksimal 200 karakter.";
    } else {
      out.description = description;
    }
  }

  return out;
}

/** Deteksi pelanggaran unique constraint Prisma (P2002). */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" && e !== null && "code" in e && (e as { code?: unknown }).code === "P2002"
  );
}

/** GET /api/admin/categories — daftar kategori + jumlah produk (khusus ADMIN). */
export async function GET() {
  try {
    await requireRole("ADMIN");

    const categories = await prisma.category.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { products: true } } },
    });

    return Response.json({
      items: categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        productCount: c._count.products,
      })),
      total: categories.length,
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/categories GET]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/** POST /api/admin/categories — tambah kategori. */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    await requireRole("ADMIN");

    const body = await parseJsonBody(request);
    const input = validateCategory(body);
    if (Object.keys(input.errors).length > 0) {
      throw new ApiError(400, "Data tidak valid.", input.errors);
    }
    if (input.name === undefined) {
      throw new ApiError(400, "Data tidak valid.", input.errors);
    }

    try {
      const category = await prisma.category.create({
        data: { name: input.name, description: input.description ?? null },
      });
      return Response.json(
        { message: "Kategori ditambahkan.", categoryId: category.id },
        { status: 201 },
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ApiError(400, "Nama kategori sudah dipakai.", {
          name: "Nama kategori sudah dipakai.",
        });
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/admin/categories POST]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

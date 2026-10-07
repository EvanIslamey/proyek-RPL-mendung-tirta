import type { NextRequest } from "next/server";
import { requireRole, requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * POST /api/products/[id]/reviews — beri ulasan (wajib login + pernah membeli
 * produk ini dan pesanannya berstatus COMPLETED).
 * Satu pembeli hanya boleh satu ulasan per produk (unique constraint di DB).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireRole("BUYER");
    const { id: productId } = await params;

    const body = await parseJsonBody(request);

    const rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ApiError(400, "Rating harus berupa angka 1–5.", {
        rating: "Rating harus 1–5.",
      });
    }

    const commentRaw = typeof body.comment === "string" ? body.comment.trim() : "";
    if (commentRaw.length > 1000) {
      throw new ApiError(400, "Komentar maksimal 1000 karakter.", {
        comment: "Komentar maksimal 1000 karakter.",
      });
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, status: true },
    });
    if (!product || product.status === "HIDDEN") {
      throw new ApiError(404, "Produk tidak ditemukan.");
    }

    // Syarat: pernah membeli produk ini dalam pesanan COMPLETED.
    const purchased = await prisma.orderItem.findFirst({
      where: {
        productId,
        order: { buyerId: user.id, status: "COMPLETED" },
      },
      select: { id: true },
    });
    if (!purchased) {
      throw new ApiError(
        403,
        "Anda hanya dapat mengulas produk yang telah Anda beli (pesanan selesai).",
      );
    }

    try {
      const review = await prisma.review.create({
        data: { productId, buyerId: user.id, rating, comment: commentRaw || null },
      });
      return Response.json(
        {
          review: {
            id: review.id,
            rating: review.rating,
            comment: review.comment,
            createdAt: review.createdAt.toISOString(),
          },
        },
        { status: 201 },
      );
    } catch (e) {
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        (e as { code?: unknown }).code === "P2002"
      ) {
        throw new ApiError(409, "Anda sudah mengulas produk ini. Gunakan PATCH untuk mengubah.");
      }
      throw e;
    }
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/reviews POST]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

/**
 * PATCH /api/products/[id]/reviews — ubah ulasan sendiri.
 * Body: { rating?: number, comment?: string }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();
    const { id: productId } = await params;
    const body = await parseJsonBody(request);

    const existing = await prisma.review.findUnique({
      where: { buyerId_productId: { buyerId: user.id, productId } },
    });
    if (!existing) {
      throw new ApiError(404, "Ulasan tidak ditemukan.");
    }

    const data: { rating?: number; comment?: string | null } = {};

    if (body.rating !== undefined) {
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new ApiError(400, "Rating harus 1–5.", { rating: "Rating harus 1–5." });
      }
      data.rating = rating;
    }
    if (body.comment !== undefined) {
      const comment = typeof body.comment === "string" ? body.comment.trim() : "";
      if (comment.length > 1000) {
        throw new ApiError(400, "Komentar maksimal 1000 karakter.");
      }
      data.comment = comment || null;
    }

    const updated = await prisma.review.update({ where: { id: existing.id }, data });
    return Response.json({
      review: {
        id: updated.id,
        rating: updated.rating,
        comment: updated.comment,
        createdAt: updated.createdAt.toISOString(),
      },
    });
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/reviews PATCH]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

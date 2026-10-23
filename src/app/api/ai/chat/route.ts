import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { generateReply, parseProductFilters, type AiChatMessage } from "@/lib/ai";
import { buildChatContext } from "@/lib/ai-context";
import { hitRateLimit } from "@/lib/rate-limit";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * POST /api/ai/chat — asisten AI berbasis data aktual (wajib login, key hanya di backend).
 *
 * Alur: sesi login → rate limit → buildChatContext (query terkini, discoping
 * peran dari sesi, bukan dari body request) → generateReply (AI / fallback).
 *
 * Body: { message: string, history?: { role, content }[] }
 * Response: { reply, products[], sources[], generatedAt, source: "ai" | "fallback" }
 */
export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireUser();

    const limit = hitRateLimit(`ai:${user.id}`, 10, 60_000);
    if (!limit.ok) {
      return Response.json(
        { message: `Terlalu banyak pertanyaan. Coba lagi dalam ${limit.retryAfterSeconds} detik.` },
        { status: 429 },
      );
    }

    const body = await parseJsonBody(request);

    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (message.length < 1 || message.length > 1000) {
      throw new ApiError(400, "Pesan harus 1–1000 karakter.");
    }

    let history: AiChatMessage[] = [];
    const contextProductIds: string[] = [];
    if (Array.isArray(body.history)) {
      history = body.history
        .filter(
          (h): h is { role: string; content: string; productIds?: unknown } =>
            !!h &&
            typeof h === "object" &&
            ((h as { role?: unknown }).role === "user" ||
              (h as { role?: unknown }).role === "assistant") &&
            typeof (h as { content?: unknown }).content === "string",
        )
        .slice(-8)
        .map((h) => {
          // Kumpulkan ID produk dari balasan asisten sebelumnya (maks 3,
          // format UUID) — divalidasi ulang dari DB oleh buildChatContext.
          if (h.role === "assistant" && Array.isArray(h.productIds)) {
            for (const id of h.productIds.slice(0, 3)) {
              if (
                typeof id === "string" &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) &&
                contextProductIds.length < 6 &&
                !contextProductIds.includes(id)
              ) {
                contextProductIds.push(id);
              }
            }
          }
          return {
            role: h.role as "user" | "assistant",
            content: h.content.slice(0, 2000),
          };
        });
    }

    // 1. Grounding: query terkini dari DB, discoping peran sesi login.
    let context;
    try {
      context = await buildChatContext(user, message, { contextProductIds });
    } catch (dbErr) {
      // DB tidak tersedia → jawab ramah tanpa stack trace (A5).
      console.error(
        "[api/ai/chat] context gagal:",
        dbErr instanceof Error ? `${dbErr.name}: ${dbErr.message}` : dbErr,
      );
      return Response.json({
        reply:
          "Maaf, layanan data sedang tidak tersedia. Silakan coba lagi beberapa saat lagi.",
        products: [],
        sources: [],
        generatedAt: new Date().toISOString(),
        source: "fallback",
      });
    }

    // Parse filter gabungan dari pesan untuk konteks AI
    const filters = parseProductFilters(message);

    // 2. Balasan (AI bila provider berhasil, fallback berbasis data bila tidak).
    const result = await generateReply({
      message,
      history,
      products: context.products,
      sections: context.sections,
      contextProducts: context.contextProducts,
      focus: context.focus,
      focusCandidates: context.focusCandidates,
      ambiguousFollowUp: context.ambiguousFollowUp,
      filters,
    });

    return Response.json(result);
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/ai/chat]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  generateReply,
  streamReply,
  type AiChatMessage,
  type AiChatOpts,
  type AiStreamEvent,
} from "@/lib/ai";
import { buildChatContext } from "@/lib/ai-context";
import { hitRateLimit } from "@/lib/rate-limit";
import { ApiError, assertSameOrigin, parseJsonBody } from "@/lib/validate";

/**
 * POST /api/ai/chat — asisten AI berbasis data aktual (wajib login, key hanya di backend).
 *
 * Alur: sesi login → rate limit → buildChatContext (query terkini, discoping
 * peran dari sesi, bukan dari body request) → putuskan jalur (planReply di
 * dalam generateReply/streamReply):
 * - pertanyaan ber-data/sapaan/filter → JSON biasa, INSTAN (tanpa AI);
 * - pertanyaan umum + body `stream:true` → SSE (`text/event-stream`):
 *   event `{"type":"delta"}` → `{"type":"done"|"failed","result":{…}}`.
 *
 * Setiap tahap dicatat `[ai-timing]` agar bottleneck mudah ditemukan.
 *
 * Body: { message: string, history?: { role, content }[], stream?: boolean }
 * Response: { reply, products[], sources[], generatedAt, source: "ai" | "fallback" }
 *           atau stream SSE (bila stream:true & jalur AI).
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
    const wantStream = body.stream === true;

    let history: AiChatMessage[] = [];
    const contextProductIds: string[] = [];
    const recentUserMessages: string[] = [];
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
          // Simpan teks pesan user sebelumnya (maks 4) — untuk retensi
          // subjek filter ("di bawah 50000" setelah "hasil laut").
          if (h.role === "user") {
            recentUserMessages.push((h as { content: string }).content);
            if (recentUserMessages.length > 4) recentUserMessages.shift();
          }
          return {
            role: h.role as "user" | "assistant",
            content: h.content.slice(0, 2000),
          };
        });
    }

    const t0 = performance.now();

    // 1. Grounding: query terkini dari DB, discoping peran sesi login.
    let context;
    try {
      context = await buildChatContext(user, message, {
        contextProductIds,
        recentUserMessages,
      });
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
    const ctxMs = Math.round(performance.now() - t0);

    // Opsi balasan — keputusan jalur (direct/AI) ada di dalam planReply,
    // sehingga mode JSON dan streaming tidak pernah berbeda jawabannya.
    const chatOpts: AiChatOpts = {
      message,
      history,
      products: context.products,
      sections: context.sections,
      contextProducts: context.contextProducts,
      focus: context.focus,
      focusCandidates: context.focusCandidates,
      ambiguousFollowUp: context.ambiguousFollowUp,
      filters: context.filters,
      subjectAmbiguity: context.subjectAmbiguity,
    };

    // 2a. Streaming (SSE) — hanya bila diminta; jalur tetap menentukan sendiri.
    if (wantStream) {
      const clientCtl = new AbortController();
      const onAbort = () => clientCtl.abort();
      if (request.signal.aborted) clientCtl.abort();
      else request.signal.addEventListener("abort", onAbort, { once: true });

      const encoder = new TextEncoder();
      let finalLabel = "belum-selesai";
      const sse = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const ev of streamReply(chatOpts, clientCtl.signal)) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
              if (ev.type !== "delta") {
                const r = (ev as Extract<AiStreamEvent, { type: "done" | "failed" }>).result;
                finalLabel = `${ev.type}/${r.source}${r.fallbackReason ? `:${r.fallbackReason}` : ""}`;
              }
            }
          } catch (err) {
            // Kegagalan tak terduga di tengah stream → tutup dengan jawaban
            // jujur agar client tidak menggantung tanpa respons.
            console.error(
              "[api/ai/chat] stream gagal:",
              err instanceof Error ? `${err.name}: ${err.message}` : err,
            );
            try {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "failed",
                    result: {
                      reply:
                        "Maaf, terjadi kesalahan saat menyusun jawaban. Silakan coba lagi.",
                      products: [],
                      sources: [],
                      generatedAt: new Date().toISOString(),
                      source: "fallback",
                      fallbackReason: "provider-error",
                    },
                  })}\n\n`,
                ),
              );
              finalLabel = "stream-error";
            } catch {
              /* controller sudah ditutup client */
            }
          } finally {
            request.signal.removeEventListener("abort", onAbort);
            try {
              controller.close();
            } catch {
              /* sudah tertutup */
            }
            console.log(
              `[ai-timing] ctx=${ctxMs}ms total=${Math.round(performance.now() - t0)}ms ` +
                `path=stream ${finalLabel}`,
            );
          }
        },
        cancel() {
          // Client berhenti membaca (tutup tab / tombol berhenti) → batalkan
          // provider agar tidak membuang token.
          clientCtl.abort();
          request.signal.removeEventListener("abort", onAbort);
        },
      });

      return new Response(sse, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // 2b. JSON biasa (jalur direct instan / suite & skrip lama).
    const result = await generateReply(chatOpts);
    console.log(
      `[ai-timing] ctx=${ctxMs}ms total=${Math.round(performance.now() - t0)}ms ` +
        `path=json source=${result.source}${result.fallbackReason ? `:${result.fallbackReason}` : ""} ` +
        `chars=${result.reply.length}`,
    );
    return Response.json(result);
  } catch (e) {
    if (e instanceof ApiError) {
      return Response.json({ message: e.message, fields: e.fields }, { status: e.status });
    }
    console.error("[api/ai/chat]", e instanceof Error ? `${e.name}: ${e.message}` : e);
    return Response.json({ message: "Terjadi kesalahan pada server." }, { status: 500 });
  }
}

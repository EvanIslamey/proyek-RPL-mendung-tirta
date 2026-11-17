"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatRupiah } from "@/lib/format";
import { useSessionUser } from "@/components/layout/use-session-user";
import "./ai-widget.css";

type Product = {
  id: string;
  name: string;
  price: number;
  stock: number;
  storeName: string;
  rating: number;
};

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  products?: Product[];
  sources?: { label: string; asOf: string }[];
  source?: "ai" | "fallback";
  /** Alasan fallback dari backend — untuk catatan UI yang jujur. */
  fallbackReason?: "no-ai-config" | "filtered" | "provider-error" | "direct";
  error?: boolean;
};

const GREETING: ChatMessage = {
  id: 0,
  role: "assistant",
  text:
    "Halo! 👋 Saya asisten belanja Mendung Tirta. Mau cari apa hari ini? " +
    'Coba tulis misalnya "joran untuk pemula" atau "ikan segar hari ini".',
};

/** Event penutup stream SSE dari /api/ai/chat. */
type FinalEvent = {
  type: "done" | "failed";
  result: {
    reply?: string;
    products?: Product[];
    sources?: { label: string; asOf: string }[];
    source?: "ai" | "fallback";
    fallbackReason?: ChatMessage["fallbackReason"];
  };
};

/** Bentuk mentah satu event SSE hasil JSON.parse (belum tervalidasi). */
type ParsedEvent = { type?: unknown; text?: unknown; result?: unknown };

/** Sembunyikan hanya di halaman autentikasi — di semua halaman lain (termasuk
 *  dashboard seller/admin setelah login) chatbot tetap tersedia (Bagian 3). */
const HIDDEN_PREFIXES = ["/login", "/register"];

/** Batas wajar riwayat percakapan (jumlah pesan di sesi & di penyimpanan). */
const MAX_MESSAGES = 40;

const storageKeyFor = (userId: string): string => `mt-ai-chat:${userId}`;

function isStoredMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== "object") return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.id === "number" &&
    (o.role === "user" || o.role === "assistant") &&
    typeof o.text === "string"
  );
}

/** Pulihkan riwayat chat milik akun INI dari sessionStorage (per tab). */
function loadStoredMessages(userId: string): ChatMessage[] | null {
  try {
    const raw = sessionStorage.getItem(storageKeyFor(userId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const msgs = parsed.filter(isStoredMessage).slice(-MAX_MESSAGES);
    return msgs.length > 0 ? msgs : null;
  } catch {
    return null; // storage diblokir/penuh → riwayat hanya di memori
  }
}

function saveStoredMessages(userId: string, messages: ChatMessage[]): void {
  try {
    sessionStorage.setItem(
      storageKeyFor(userId),
      JSON.stringify(messages.slice(-MAX_MESSAGES)),
    );
  } catch {
    /* abaikan — riwayat tetap ada di memori sesi */
  }
}

function clearStoredMessages(userId: string): void {
  try {
    sessionStorage.removeItem(storageKeyFor(userId));
  } catch {
    /* abaikan */
  }
}

/** Tambah satu pesan + terapkan batas riwayat (contextual typing terjaga). */
function appendMessage(prev: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  return [...prev, msg].slice(-MAX_MESSAGES);
}

export function AIWidget() {
  const pathname = usePathname();
  const sessionUser = useSessionUser();
  const userId = sessionUser?.id ?? null;
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** Indikator "Sedang berpikir…" tampil sampai delta/jawaban pertama tiba. */
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  /** Pembatal streaming (tombol Berhenti / ganti akun / unmount). */
  const abortRef = useRef<AbortController | null>(null);
  /** Id akun TERBARU — untuk memastikan stream lama tidak menulis ke sesi akun baru. */
  const userIdRef = useRef<string | null>(null);
  userIdRef.current = userId;
  // Id akun yang konteksnya sedang aktif di sesi ini (undefined = belum pernah).
  const [trackedUserId, setTrackedUserId] = useState<string | null | undefined>(undefined);

  // Isolasi konteks per akun — pola resmi React "adjusting state during render":
  // saat id akun berubah (login/logout/ganti akun), sesi aktif dibersihkan dari
  // konteks akun sebelumnya lalu memuat riwayat milik akun baru (jika ada).
  // Dijalankan saat render (bukan efek) → tanpa cascading render.
  if (trackedUserId !== userId) {
    // Keluar/ganti akun → hapus riwayat tersimpan akun SEBELUMNYA: sesi
    // berikutnya wajib mulai bersih (syarat: reset saat logout/ganti akun).
    if (trackedUserId) clearStoredMessages(trackedUserId);
    const stored = userId ? loadStoredMessages(userId) : null;
    setTrackedUserId(userId);
    setMessages(stored ?? [GREETING]);
    // Jangan tutup panel saat mount pertama — hanya saat akun benar-benar berganti.
    if (trackedUserId !== undefined) setOpen(false);
  }

  // nextId (ref) disesuaikan lewat efek — ref hanya boleh diakses di luar render.
  useEffect(() => {
    const stored = trackedUserId ? loadStoredMessages(trackedUserId) : null;
    nextId.current = stored ? stored.reduce((m, x) => Math.max(m, x.id + 1), 1) : 1;
  }, [trackedUserId]);

  // Persistensi riwayat per akun (bertahan saat berpindah halaman & reload).
  useEffect(() => {
    if (userId && messages.length > 0) saveStoredMessages(userId, messages);
  }, [userId, messages]);

  // Ganti akun / logout / unmount → batalkan streaming yang sedang berjalan
  // agar jawaban lama tidak bocor ke sesi akun baru (reset percakapan).
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, [userId]);

  useEffect(() => {
    if (open) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      inputRef.current?.focus();
    }
  }, [open, messages, busy]);

  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  function resetChat() {
    setMessages([GREETING]);
    nextId.current = 1;
    if (userId) clearStoredMessages(userId);
  }

  async function send(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;

    const sendUserId = userId; // akun saat pesan dikirim
    const sameAccount = (): boolean => userIdRef.current === sendUserId;

    const history = messages
      .filter((m) => !m.error)
      .map((m) => ({
        role: m.role,
        content: m.text,
        // Sertakan ID produk dari balasan sebelumnya — backend memvalidasi
        // ulang harga/stoknya dari DB (bukan ingatan model).
        ...(m.products && m.products.length > 0
          ? { productIds: m.products.slice(0, 3).map((p) => p.id) }
          : {}),
      }));
    const userIdMsg = nextId.current++;
    const assistantId = nextId.current++;

    setMessages((prev) => appendMessage(prev, { id: userIdMsg, role: "user", text: message }));
    setInput("");
    setBusy(true);
    setThinking(true);

    const ctl = new AbortController();
    abortRef.current = ctl;
    /** Teks streaming sejauh ini — dipertahankan bila koneksi putus. */
    let streamed = "";

    /** Tambah/ubah pesan asisten (id assistantId) — abaikan bila akun berganti. */
    const upsertAssistant = (text: string): void => {
      if (!sameAccount()) return;
      streamed = text;
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return appendMessage(prev, { id: assistantId, role: "assistant", text });
        return prev.map((m) => (m.id === assistantId ? { ...m, text } : m));
      });
    };

    /** Finalkan jawaban (event done/failed atau JSON) — ganti bila sudah ada. */
    const finalize = (data: {
      reply?: string;
      products?: Product[];
      sources?: { label: string; asOf: string }[];
      source?: "ai" | "fallback";
      fallbackReason?: ChatMessage["fallbackReason"];
    }): void => {
      if (!sameAccount()) return;
      setMessages((prev) => {
        const final: ChatMessage = {
          id: assistantId,
          role: "assistant",
          text: data.reply ?? "Maaf, saya belum bisa menjawab.",
          products: data.products,
          sources: data.sources,
          source: data.source,
          fallbackReason: data.fallbackReason,
        };
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return appendMessage(prev, final);
        return prev.map((m) => (m.id === assistantId ? final : m));
      });
    };

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: history.slice(-8), stream: true }),
        signal: ctl.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        const text =
          res.status === 401
            ? "Silakan masuk terlebih dahulu untuk memakai asisten."
            : (data.message ?? "Maaf, terjadi kesalahan. Coba lagi.");
        if (sameAccount()) {
          setMessages((prev) =>
            appendMessage(prev, { id: assistantId, role: "assistant", text, error: true }),
          );
        }
        return;
      }

      const ctype = res.headers.get("content-type") ?? "";
      if (ctype.includes("text/event-stream") && res.body) {
        // Jalur streaming: pesan user sudah tampil & teks jawaban mengalir
        // bertahap; event "done"/"failed" mengganti teks parsial dengan
        // jawaban final tervalidasi (marker [produk:id] dibersihkan backend).
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        let final: FinalEvent | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            let ev: ParsedEvent;
            try {
              ev = JSON.parse(line.slice(5)) as ParsedEvent;
            } catch {
              continue;
            }
            if (!ev || typeof ev !== "object") continue;
            if (ev.type === "delta" && typeof ev.text === "string") {
              setThinking(false);
              upsertAssistant(streamed + ev.text);
            } else if (
              (ev.type === "done" || ev.type === "failed") &&
              ev.result &&
              typeof ev.result === "object"
            ) {
              final = ev as unknown as FinalEvent;
            }
          }
        }
        if (final) {
          setThinking(false);
          finalize(final.result);
        } else if (streamed) {
          // Koneksi putus di tengah jawaban → pertahankan parsial + tanda jujur.
          setThinking(false);
          if (sameAccount()) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, text: streamed, error: true } : m,
              ),
            );
          }
        } else {
          throw new Error("stream berakhir tanpa jawaban");
        }
      } else {
        // Jalur JSON: jawaban langsung/fallback dari backend (instan).
        const data = await res.json().catch(() => ({}));
        setThinking(false);
        finalize(data);
      }
    } catch {
      setThinking(false);
      if (ctl.signal.aborted) {
        // Dihentikan user (tombol Berhenti) atau akun berganti: pertahankan
        // teks parsial bila ada; beri catatan singkat bila belum ada jawaban.
        if (sameAccount() && !streamed) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === assistantId)) return prev;
            return appendMessage(prev, {
              id: assistantId,
              role: "assistant",
              text: "⏹ Respons dihentikan.",
            });
          });
        }
      } else if (sameAccount()) {
        setMessages((prev) =>
          appendMessage(prev, {
            id: assistantId,
            role: "assistant",
            text: "Tidak dapat terhubung ke server. Periksa koneksi Anda.",
            error: true,
          }),
        );
      }
      // Akun berganti di tengah koneksi → jangan tulis apa pun ke sesi baru.
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
      setBusy(false);
      setThinking(false);
    }
  }

  return (
    <>
      {open && (
        <section className="ai-panel" aria-label="Asisten Mendung Tirta">
          <header className="ai-panel-head">
            <div>
              <strong>Asisten Mendung Tirta</strong>
              <span className="ai-status">Tanya produk, stok, pesanan & statistik</span>
            </div>
            <div className="ai-head-actions">
              <button
                type="button"
                className="ai-reset"
                title="Percakapan baru"
                aria-label="Mulai percakapan baru"
                onClick={resetChat}
              >
                ↺
              </button>
              <button type="button" aria-label="Tutup asisten" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
          </header>

          <div className="ai-messages" ref={scrollRef} aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`ai-msg ai-msg-${m.role}${m.error ? " ai-msg-error" : ""}`}>
                <p className="ai-msg-text">{m.text}</p>

                {m.role === "assistant" && !!m.sources?.length && (
                  <span className="ai-note ai-sources">
                    Sumber: {m.sources.map((s) => s.label).join(" • ")}
                    {" • diperbarui "}
                    {new Date(m.sources[m.sources.length - 1].asOf).toLocaleTimeString("id-ID", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                )}

                {m.products && m.products.length > 0 && (
                  <ul className="ai-products">
                    {m.products.map((p) => (
                      <li key={p.id}>
                        <Link href={`/products/${p.id}`} onClick={() => setOpen(false)}>
                          <span className="ai-product-name">{p.name}</span>
                          <span className="ai-product-meta">
                            {formatRupiah(p.price)} • {p.storeName}
                            {p.rating > 0 && ` • ⭐ ${p.rating}`}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}

            {busy && thinking && (
              <div className="ai-msg ai-msg-assistant" aria-busy="true">
                <p className="ai-msg-text">
                  Sedang berpikir
                  <span className="ai-dots" aria-hidden="true">
                    <i>.</i>
                    <i>.</i>
                    <i>.</i>
                  </span>
                </p>
              </div>
            )}
          </div>

          <form className="ai-input-row" onSubmit={send}>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Tulis pertanyaan…"
              maxLength={1000}
              aria-label="Pesan untuk asisten"
            />
            {busy ? (
              <button
                type="button"
                className="btn btn-sm ai-stop"
                onClick={() => abortRef.current?.abort()}
                aria-label="Hentikan respons asisten"
              >
                Berhenti
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={!input.trim()}
              >
                Kirim
              </button>
            )}
          </form>
        </section>
      )}

      <button
        type="button"
        className="ai-fab"
        aria-label={open ? "Tutup asisten AI" : "Buka asisten AI"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        ) : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.6-.9L3 21l1.9-4.7A8.2 8.2 0 0 1 3.6 11.5a8.4 8.4 0 0 1 8.7-8.4 8.4 8.4 0 0 1 8.7 8.4Z" />
            <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
          </svg>
        )}
      </button>
    </>
  );
}

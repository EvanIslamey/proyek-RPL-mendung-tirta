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
  fallbackReason?: "no-ai-config" | "filtered" | "provider-error";
  error?: boolean;
};

const GREETING: ChatMessage = {
  id: 0,
  role: "assistant",
  text:
    "Halo! 👋 Saya asisten belanja Mendung Tirta. Mau cari apa hari ini? " +
    'Coba tulis misalnya "joran untuk pemula" atau "ikan segar hari ini".',
};

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
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

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, history: history.slice(-8) }),
      });
      const data: {
        reply?: string;
        products?: Product[];
        sources?: { label: string; asOf: string }[];
        source?: "ai" | "fallback";
        fallbackReason?: ChatMessage["fallbackReason"];
        message?: string;
      } = await res.json().catch(() => ({}));

      if (!res.ok) {
        const text =
          res.status === 401
            ? "Silakan masuk terlebih dahulu untuk memakai asisten."
            : (data.message ?? "Maaf, terjadi kesalahan. Coba lagi.");
        setMessages((prev) =>
          appendMessage(prev, { id: assistantId, role: "assistant", text, error: true }),
        );
        return;
      }

      setMessages((prev) =>
        appendMessage(prev, {
          id: assistantId,
          role: "assistant",
          text: data.reply ?? "Maaf, saya belum bisa menjawab.",
          products: data.products,
          sources: data.sources,
          source: data.source,
          fallbackReason: data.fallbackReason,
        }),
      );
    } catch {
      setMessages((prev) =>
        appendMessage(prev, {
          id: assistantId,
          role: "assistant",
          text: "Tidak dapat terhubung ke server. Periksa koneksi Anda.",
          error: true,
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  // Catatan jujur sesuai kondisi fallback (Bagian 2E) — provider error diberi
  // penekanan visual, bukan disamarkan sebagai jawaban normal.
  function fallbackNote(reason: ChatMessage["fallbackReason"]): string {
    switch (reason) {
      case "provider-error":
        return "AI sementara tidak tersedia — jawaban diambil dari data database terkini. Penyebabnya sudah dicatat di server.";
      case "filtered":
        return "Disusun langsung dari data database terkini (query terfilter).";
      case "no-ai-config":
        return "Mode katalog — jawaban dari data database terkini (AI belum dikonfigurasi).";
      default:
        return "Mode katalog — jawaban dari data database terkini (tanpa AI).";
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

                {m.source === "fallback" && (
                  <span
                    className={`ai-note${
                      m.fallbackReason === "provider-error" ? " ai-note-warn" : ""
                    }`}
                  >
                    {fallbackNote(m.fallbackReason)}
                  </span>
                )}

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

            {busy && (
              <div className="ai-msg ai-msg-assistant" aria-busy="true">
                <p className="ai-msg-text">Mengetik…</p>
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
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !input.trim()}>
              Kirim
            </button>
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
        {open ? "×" : "💬"}
      </button>
    </>
  );
}

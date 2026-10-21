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
  error?: boolean;
};

const GREETING: ChatMessage = {
  id: 0,
  role: "assistant",
  text:
    "Halo! 👋 Saya asisten belanja Mendung Tirta. Mau cari apa hari ini? " +
    'Coba tulis misalnya "joran untuk pemula" atau "ikan segar hari ini".',
};

/** Sembunyikan widget di area dashboard & halaman autentikasi. */
const HIDDEN_PREFIXES = ["/seller", "/admin", "/login", "/register"];

export function AIWidget() {
  const pathname = usePathname();
  const sessionUser = useSessionUser();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const lastUserId = useRef<string | null | undefined>(undefined);

  // Isolasi konteks per akun: reset riwayat chat saat login/logout/ganti akun
  // — jangan membawa konteks percakapan akun sebelumnya.
  useEffect(() => {
    if (lastUserId.current === undefined) {
      lastUserId.current = sessionUser?.id ?? null; // mount pertama: jangan reset
      return;
    }
    if (lastUserId.current !== (sessionUser?.id ?? null)) {
      lastUserId.current = sessionUser?.id ?? null;
      setMessages([GREETING]);
      nextId.current = 1;
      setOpen(false);
    }
  }, [sessionUser?.id]);

  useEffect(() => {
    if (open) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      inputRef.current?.focus();
    }
  }, [open, messages, busy]);

  if (HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
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
    const userId = nextId.current++;
    const assistantId = nextId.current++;

    setMessages((prev) => [...prev, { id: userId, role: "user", text: message }]);
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
        message?: string;
      } = await res.json().catch(() => ({}));

      if (!res.ok) {
        const text =
          res.status === 401
            ? "Silakan masuk terlebih dahulu untuk memakai asisten."
            : (data.message ?? "Maaf, terjadi kesalahan. Coba lagi.");
        setMessages((prev) => [
          ...prev,
          { id: assistantId, role: "assistant", text, error: true },
        ]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          text: data.reply ?? "Maaf, saya belum bisa menjawab.",
          products: data.products,
          sources: data.sources,
          source: data.source,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          text: "Tidak dapat terhubung ke server. Periksa koneksi Anda.",
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
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
            <button type="button" aria-label="Tutup asisten" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>

          <div className="ai-messages" ref={scrollRef} aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`ai-msg ai-msg-${m.role}${m.error ? " ai-msg-error" : ""}`}>
                <p className="ai-msg-text">{m.text}</p>

                {m.source === "fallback" && (
                  <span className="ai-note">Mode katalog — jawaban dari data database terkini (tanpa AI).</span>
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

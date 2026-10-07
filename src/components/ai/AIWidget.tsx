"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { formatRupiah } from "@/lib/format";
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
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([GREETING]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);

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
      .map((m) => ({ role: m.role, content: m.text }));
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
              <span className="ai-status">Tanya produk, stok & harga</span>
            </div>
            <button type="button" aria-label="Tutup asisten" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>

          <div className="ai-messages" ref={scrollRef} aria-live="polite">
            {messages.map((m) => (
              <div key={m.id} className={`ai-msg ai-msg-${m.role}${m.error ? " ai-msg-error" : ""}`}>
                <p className="ai-msg-text">{m.text}</p>

                {m.source === "fallback" && (m.products?.length ?? 0) > 0 && (
                  <span className="ai-note">Mode katalog — jawaban dari pencarian database.</span>
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

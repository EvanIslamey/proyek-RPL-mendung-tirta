"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import "./notification-bell.css";

type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
};

const KIND_ICON: Record<string, string> = {
  ORDER_CREATED: "📦",
  ORDER_STATUS_CHANGED: "🔄",
  PAYMENT_CONFIRMED: "✅",
  STOCK_LOW: "📉",
  ACCOUNT_ALERT: "ℹ️",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMin = Math.floor((now - d.getTime()) / 60_000);
  if (diffMin < 1) return "baru saja";
  if (diffMin < 60) return `${diffMin} mnt lalu`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} jam lalu`;
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" });
}

/**
 * Lonceng notifikasi in-app (Fitur C). Data hanya milik user yang login
 * (API /api/notifications menyaring di backend). Poll 45 dtk + saat window
 * fokus. Tanpa login → tidak tampil.
 */
export function NotificationBell() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications", { cache: "no-store" });
      if (r.status === 401) {
        setItems([]);
        setUnread(0);
        return; // tamu
      }
      if (!r.ok) return;
      const d: { items?: NotificationItem[]; unread?: number } = await r.json();
      setItems(d.items ?? []);
      setUnread(d.unread ?? 0);
    } catch {
      /* jaringan/server tidak tersedia — biarkan UI diam */
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cleanupFn: (() => void) | null = null;

    async function initial() {
      await load();
      if (!cancelled) {
        const t = setInterval(() => void load(), 45_000);
        const onFocus = () => void load();
        window.addEventListener("focus", onFocus);
        cleanupFn = () => {
          clearInterval(t);
          window.removeEventListener("focus", onFocus);
        };
      }
    }
    initial();
    return () => {
      cancelled = true;
      if (cleanupFn) cleanupFn();
    };
  }, [load]);

  // Tutup panel saat klik di luar.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function markRead(id: string) {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n)),
    );
    setUnread((u) => Math.max(0, u - 1));
    await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [id] }),
    }).catch(() => undefined);
  }

  async function markAll() {
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnread(0);
    await fetch("/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).catch(() => undefined);
  }

  async function handleItem(n: NotificationItem) {
    await markRead(n.id);
    setOpen(false);
    if (n.link) router.push(n.link);
  }

  return (
    <div className="nb-wrap" ref={boxRef}>
      <button
        type="button"
        className="nb-bell"
        aria-label={`Notifikasi${unread > 0 ? `, ${unread} belum dibaca` : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        🔔
        {unread > 0 && <span className="nb-badge">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <div className="nb-panel" role="menu" aria-label="Daftar notifikasi">
          <div className="nb-panel-head">
            <strong>Notifikasi</strong>
            {unread > 0 && (
              <button type="button" className="nb-link" onClick={markAll}>
                Tandai semua dibaca
              </button>
            )}
          </div>
          <div className="nb-list">
            {items.length === 0 && (
              <p className="nb-empty">Tidak ada notifikasi. Belanja untuk mendapat update. 🌊</p>
            )}
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`nb-item${n.readAt ? " read" : ""}`}
                onClick={() => void handleItem(n)}
              >
                <span className="nb-item-icon" aria-hidden="true">
                  {KIND_ICON[n.kind] ?? "🔔"}
                </span>
                <span className="nb-item-body">
                  <span className="nb-item-title">{n.title}</span>
                  <span className="nb-item-text">{n.body}</span>
                  <span className="nb-item-time">{formatTime(n.createdAt)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

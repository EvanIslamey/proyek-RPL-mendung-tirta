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

const Svg = ({ children }: { children: React.ReactNode }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const KIND_ICON: Record<string, React.ReactNode> = {
  ORDER_CREATED: (
    <Svg>
      <path d="m12 3 8 4v10l-8 4-8-4V7l8-4Z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
    </Svg>
  ),
  ORDER_STATUS_CHANGED: (
    <Svg>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </Svg>
  ),
  PAYMENT_CONFIRMED: (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8 12.5 2.8 2.8L16 9.5" />
    </Svg>
  ),
  STOCK_LOW: (
    <Svg>
      <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
    </Svg>
  ),
  ACCOUNT_ALERT: (
    <Svg>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  ),
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
              <p className="nb-empty">Tidak ada notifikasi. Belanja untuk mendapat update.</p>
            )}
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`nb-item${n.readAt ? " read" : ""}`}
                onClick={() => void handleItem(n)}
              >
                <span className="nb-item-icon" aria-hidden="true">
                  {KIND_ICON[n.kind] ?? (
                    <Svg>
                      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7Z" />
                      <path d="M10.5 20a2 2 0 0 0 3 0" />
                    </Svg>
                  )}
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

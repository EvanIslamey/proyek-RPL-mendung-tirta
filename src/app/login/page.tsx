"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { notifySessionChanged } from "@/components/layout/use-session-user";
import "../auth.css";

function LoginForm() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    setError(null);
    setFields({});

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 400 && data.fields) setFields(data.fields);
        setError(data.message ?? "Terjadi kesalahan. Coba lagi.");
        return;
      }

      // Hanya redirect ke path internal (hindari open redirect).
      // Param dibaca dari URL saat submit (bukan useSearchParams) agar
      // halaman bisa di-prerender statis tanpa fallback Suspense kosong.
      const next = new URLSearchParams(window.location.search).get("next");
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
      notifySessionChanged(); // navbar & widget chat segarkan sesi (reset konteks chat)
      router.push(safeNext);
      router.refresh();
    } catch {
      setError("Tidak dapat terhubung ke server. Periksa koneksi Anda.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-wrapper">
      <Link href="/" className="auth-logo">
        Mendung <span>Tirta</span>
      </Link>
      <div className="auth-card">
        <h1>Masuk</h1>
        <p className="auth-subtitle">Selamat datang kembali di Mendung Tirta.</p>

        {error && (
          <div className="auth-alert" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} noValidate>
          <div className="auth-field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              placeholder="nama@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={fields.email ? "true" : undefined}
              required
            />
            {fields.email && <p className="auth-error-text">{fields.email}</p>}
          </div>

          <div className="auth-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fields.password ? "true" : undefined}
              required
            />
            {fields.password && <p className="auth-error-text">{fields.password}</p>}
          </div>

          <button type="submit" className="btn btn-primary auth-submit" disabled={loading}>
            {loading ? "Memproses..." : "Masuk"}
          </button>
        </form>

        <p className="auth-alt">
          Belum punya akun? <Link href="/register">Daftar sekarang</Link>
        </p>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return <LoginForm />;
}

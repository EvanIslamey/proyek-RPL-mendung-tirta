"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import "../auth.css";

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [address, setAddress] = useState("");
  const [role, setRole] = useState<"BUYER" | "SELLER">("BUYER");
  const [storeName, setStoreName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setFields({});

    // Validasi ringan di client (server tetap validasi ulang).
    const clientErrors: Record<string, string> = {};
    if (name.trim().length < 2) clientErrors.name = "Nama minimal 2 karakter.";
    if (password.length < 8) clientErrors.password = "Password minimal 8 karakter.";
    if (password !== confirm) clientErrors.confirm = "Konfirmasi password tidak cocok.";
    if (Object.keys(clientErrors).length > 0) {
      setFields(clientErrors);
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          password,
          address: address || null,
          role,
          storeName: role === "SELLER" ? storeName || null : null,
        }),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 400 && data.fields) setFields(data.fields);
        setError(data.message ?? "Terjadi kesalahan. Coba lagi.");
        return;
      }

      router.push(role === "SELLER" ? "/seller/dashboard" : "/");
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
        <h1>Daftar</h1>
        <p className="auth-subtitle">Buat akun untuk mulai berbelanja atau berjualan.</p>

        {error && (
          <div className="auth-alert" role="alert">
            {error}
          </div>
        )}

        <form onSubmit={onSubmit} noValidate>
          <fieldset className="auth-field auth-role">
            <legend>Saya ingin mendaftar sebagai</legend>
            <div className="role-options">
              <label className={`role-option${role === "BUYER" ? " active" : ""}`}>
                <input
                  type="radio"
                  name="role"
                  value="BUYER"
                  checked={role === "BUYER"}
                  onChange={() => setRole("BUYER")}
                />
                <span className="role-icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 4h2l2.4 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.6L21 8H6" />
                    <circle cx="10" cy="20" r="1.3" />
                    <circle cx="18" cy="20" r="1.3" />
                  </svg>
                </span>
                <span className="role-label">
                  Pembeli
                  <small>Beli perlengkapan & hasil panen</small>
                </span>
              </label>
              <label className={`role-option${role === "SELLER" ? " active" : ""}`}>
                <input
                  type="radio"
                  name="role"
                  value="SELLER"
                  checked={role === "SELLER"}
                  onChange={() => setRole("SELLER")}
                />
                <span className="role-icon" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 9.5V20h16V9.5" />
                    <path d="M3 9.5 4.6 5A2 2 0 0 1 6.5 3.5h11A2 2 0 0 1 19.4 5L21 9.5H3Z" />
                    <path d="M9 20v-6h6v6" />
                  </svg>
                </span>
                <span className="role-label">
                  Penjual
                  <small>Buka toko & jual produk</small>
                </span>
              </label>
            </div>
          </fieldset>

          <div className="auth-field">
            <label htmlFor="name">Nama lengkap</label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              placeholder="Nama Anda"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={fields.name ? "true" : undefined}
              required
            />
            {fields.name && <p className="auth-error-text">{fields.name}</p>}
          </div>

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
              autoComplete="new-password"
              placeholder="Minimal 8 karakter"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={fields.password ? "true" : undefined}
              required
            />
            {fields.password && <p className="auth-error-text">{fields.password}</p>}
          </div>

          <div className="auth-field">
            <label htmlFor="confirm">Ulangi password</label>
            <input
              id="confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              placeholder="Masukkan ulang password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={fields.confirm ? "true" : undefined}
              required
            />
            {fields.confirm && <p className="auth-error-text">{fields.confirm}</p>}
          </div>

          <div className="auth-field">
            <label htmlFor="address">Alamat (opsional)</label>
            <input
              id="address"
              name="address"
              type="text"
              autoComplete="street-address"
              placeholder="Alamat pengiriman Anda"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              aria-invalid={fields.address ? "true" : undefined}
            />
            {fields.address && <p className="auth-error-text">{fields.address}</p>}
          </div>

          {role === "SELLER" && (
            <div className="auth-field">
              <label htmlFor="storeName">Nama toko</label>
              <input
                id="storeName"
                name="storeName"
                type="text"
                placeholder="mis. Hasil Laut Pak Budi"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                aria-invalid={fields.storeName ? "true" : undefined}
              />
              {fields.storeName && <p className="auth-error-text">{fields.storeName}</p>}
            </div>
          )}

          <button type="submit" className="btn btn-primary auth-submit" disabled={loading}>
            {loading ? "Memproses..." : "Daftar"}
          </button>
          <p className="auth-hint">
            Akun admin hanya dibuat melalui sistem (seed database).
          </p>
        </form>

        <p className="auth-alt">
          Sudah punya akun? <Link href="/login">Masuk di sini</Link>
        </p>
      </div>
    </main>
  );
}

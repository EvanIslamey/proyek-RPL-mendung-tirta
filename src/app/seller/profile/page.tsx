"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { formatDateId } from "@/lib/format";
import { WhatsAppSettingsPanel } from "@/components/settings/WhatsAppSettingsPanel";
import { WhatsAppPreferencesPanel } from "@/components/settings/WhatsAppPreferencesPanel";
import { IntegrationStatusPanel } from "@/components/settings/IntegrationStatusPanel";

type Profile = {
  id: string;
  name: string;
  email: string;
  role: string;
  address: string | null;
  orderCount: number;
  createdAt: string;
  telegramChatId: string | null;
  telegramNotify: boolean;
  telegramLinkedAt: string | null;
};

export default function SellerProfilePage() {
  const { toast } = useToast();
  const router = useRouter();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Form profil
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileFields, setProfileFields] = useState<Record<string, string>>({});

  // Form password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordFields, setPasswordFields] = useState<Record<string, string>>({});

  // Telegram — panel notifikasi (dipindah dari Dashboard Penjual ke sini
  // agar pengaturan akun terpusat di Informasi Diri).
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [telegramError, setTelegramError] = useState<string | null>(null);
  const [telegramSuccess, setTelegramSuccess] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [linkExpiresAt, setLinkExpiresAt] = useState<string | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/profile", { cache: "no-store" })
      .then((res) => {
        if (res.status === 401) {
          router.push("/login?next=/seller/profile");
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((d: { profile: Profile } | null) => {
        if (!d) return;
        setProfile(d.profile);
        setName(d.profile.name);
        setAddress(d.profile.address ?? "");
        setError(null);
      })
      .catch(() => {
        setError("Gagal memuat profil. Coba lagi.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, [router]);

  useEffect(() => {
    load();
  }, [load, reload]);

  // Token linking hanya dibuat bila profil SUDAH termuat dan belum terhubung
  // (mencegah pembuatan token baru tiap halaman dibuka untuk akun terhubung).
  const loadTelegramLink = useCallback(async () => {
    if (!profile) return;
    if (profile.telegramChatId) return;
    try {
      const res = await fetch("/api/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        setLinkToken(data.token);
        setLinkExpiresAt(data.expiresAt);
        setBotUsername(data.botUsername);
      }
    } catch {
      // ignore
    }
  }, [profile]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await loadTelegramLink();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTelegramLink]);

  // Telegram: buat token linking
  async function onGenerateTelegramLink() {
    if (telegramLoading) return;
    setTelegramLoading(true);
    setTelegramError(null);
    setTelegramSuccess(null);
    try {
      const res = await fetch("/api/telegram/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTelegramError(data.message ?? "Gagal membuat token linking.");
        return;
      }
      setLinkToken(data.token);
      setLinkExpiresAt(data.expiresAt);
      setBotUsername(data.botUsername);
      setTelegramSuccess("Token linking dibuat. Ikuti instruksi di bawah.");
    } catch {
      setTelegramError("Tidak dapat terhubung ke server.");
    } finally {
      setTelegramLoading(false);
    }
  }

  // Telegram: putuskan hubungan
  async function onUnlinkTelegram() {
    if (telegramLoading) return;
    setTelegramLoading(true);
    setTelegramError(null);
    setTelegramSuccess(null);
    try {
      const res = await fetch("/api/telegram/unlink", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTelegramError(data.message ?? "Gagal memutuskan hubungan Telegram.");
        return;
      }
      setTelegramSuccess("Akun Telegram berhasil diputuskan.");
      setProfile((p) =>
        p ? { ...p, telegramChatId: null, telegramLinkedAt: null, telegramNotify: true } : null,
      );
      setLinkToken(null);
      setLinkExpiresAt(null);
      setBotUsername(null);
    } catch {
      setTelegramError("Tidak dapat terhubung ke server.");
    } finally {
      setTelegramLoading(false);
    }
  }

  // Telegram: aktifkan/nonaktifkan notifikasi
  async function onToggleTelegramNotify() {
    if (!profile?.telegramChatId) return;
    setTelegramLoading(true);
    setTelegramError(null);
    try {
      const newNotify = !profile.telegramNotify;
      const res = await fetch("/api/telegram/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramNotify: newNotify }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setTelegramError(data.message ?? "Gagal mengubah preferensi.");
        return;
      }
      setProfile((p) => (p ? { ...p, telegramNotify: newNotify } : null));
      setTelegramSuccess(`Notifikasi Telegram ${newNotify ? "diaktifkan" : "dinonaktifkan"}.`);
    } catch {
      setTelegramError("Tidak dapat terhubung ke server.");
    } finally {
      setTelegramLoading(false);
    }
  }

  async function onSaveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (savingProfile) return;
    setSavingProfile(true);
    setProfileError(null);
    setProfileFields({});
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, address: address || null }),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setProfileFields(data.fields);
        setProfileError(data.message ?? "Gagal menyimpan profil.");
        return;
      }
      toast("Profil tersimpan.");
      setLoading(true);
      setError(null);
      setReload((r) => r + 1);
    } catch {
      setProfileError("Tidak dapat terhubung ke server.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function onChangePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (savingPassword) return;
    setPasswordError(null);
    setPasswordFields({});

    if (newPassword !== confirmPassword) {
      setPasswordFields({ confirmPassword: "Konfirmasi password tidak sama." });
      return;
    }

    setSavingPassword(true);
    try {
      const res = await fetch("/api/profile/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setPasswordFields(data.fields);
        setPasswordError(data.message ?? "Gagal mengubah password.");
        return;
      }
      toast("Password berhasil diubah. Perangkat lain telah logout.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch {
      setPasswordError("Tidak dapat terhubung ke server.");
    } finally {
      setSavingPassword(false);
    }
  }

  if (loading && !profile) {
    return (
      <div className="dash-loading" aria-busy="true">
        Memuat profil…
      </div>
    );
  }

  if (error && !profile) {
    return (
      <div className="form-error-banner" role="alert">
        {error}{" "}
        <button
          type="button"
          className="btn btn-sm btn-outline"
          onClick={() => {
            setLoading(true);
            setError(null);
            setReload((r) => r + 1);
          }}
        >
          Coba lagi
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Informasi Diri</h1>
          <p>
            {profile
              ? `Penjual sejak ${formatDateId(profile.createdAt)} • ${profile.orderCount} pesanan`
              : ""}
          </p>
        </div>
        <Link href="/seller/dashboard" className="btn btn-outline btn-sm">
          ← Kembali ke Dashboard
        </Link>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
          gap: "1.5rem",
          alignItems: "start",
        }}
      >
        <section className="dash-panel" style={{ marginBottom: 0 }}>
          <h2>Profil Pribadi</h2>
          <form onSubmit={onSaveProfile}>
            {profileError && (
              <div className="form-error-banner" role="alert">
                {profileError}
              </div>
            )}
            <div className="dash-form-grid" style={{ gridTemplateColumns: "1fr" }}>
              <label className="dash-form-field">
                <span>Nama lengkap *</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={100}
                  required
                />
                {profileFields.name && <span className="field-error">{profileFields.name}</span>}
              </label>
              <label className="dash-form-field">
                <span>Email</span>
                <input type="email" value={profile?.email ?? ""} disabled />
                <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>
                  Email tidak dapat diubah sendiri.
                </span>
              </label>
              <label className="dash-form-field">
                <span>Peran</span>
                <input type="text" value={profile?.role ?? ""} disabled />
                <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>
                  Role tidak dapat diubah.
                </span>
              </label>
              <label className="dash-form-field">
                <span>Alamat pengiriman</span>
                <textarea
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  maxLength={255}
                  rows={3}
                  placeholder="Nama jalan, nomor, kecamatan, kota…"
                />
                {profileFields.address && (
                  <span className="field-error">{profileFields.address}</span>
                )}
              </label>
            </div>
            <div style={{ marginTop: "1.1rem" }}>
              <button type="submit" className="btn btn-primary" disabled={savingProfile}>
                {savingProfile ? "Menyimpan…" : "Simpan Perubahan"}
              </button>
            </div>
          </form>
        </section>

        <section className="dash-panel" style={{ marginBottom: 0 }}>
          <h2>Ganti Password</h2>
          <form onChange={() => setPasswordError(null)} onSubmit={onChangePassword}>
            {passwordError && (
              <div className="form-error-banner" role="alert">
                {passwordError}
              </div>
            )}
            <div className="dash-form-grid" style={{ gridTemplateColumns: "1fr" }}>
              <label className="dash-form-field">
                <span>Password saat ini *</span>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                {passwordFields.currentPassword && (
                  <span className="field-error">{passwordFields.currentPassword}</span>
                )}
              </label>
              <label className="dash-form-field">
                <span>Password baru * (min. 8 karakter)</span>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
                {passwordFields.newPassword && (
                  <span className="field-error">{passwordFields.newPassword}</span>
                )}
              </label>
              <label className="dash-form-field">
                <span>Ulangi password baru *</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                {passwordFields.confirmPassword && (
                  <span className="field-error">{passwordFields.confirmPassword}</span>
                )}
              </label>
            </div>
            <div style={{ marginTop: "1.1rem" }}>
              <button type="submit" className="btn btn-primary" disabled={savingPassword}>
                {savingPassword ? "Memproses…" : "Ubah Password"}
              </button>
            </div>
            <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.75rem" }}>
              Setelah password berubah, sesi di perangkat lain otomatis keluar.
            </p>
          </form>
        </section>

        <section className="dash-panel" style={{ marginBottom: 0 }}>
          <h2>Informasi Akun</h2>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem 1rem" }}>
            <dt>ID Pengguna</dt>
            <dd style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>{profile?.id}</dd>
            <dt>Bergabung sejak</dt>
            <dd>{profile ? formatDateId(profile.createdAt) : ""}</dd>
            <dt>Total pesanan (sebagai pembeli)</dt>
            <dd>{profile?.orderCount ?? 0}</dd>
          </dl>
        </section>
      </div>

      {/* Bagian Pengaturan Integrasi — khusus penjual (konfigurasi WhatsApp miliknya sendiri). */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: "1.5rem",
          alignItems: "start",
          marginTop: "1.5rem",
        }}
      >
        <WhatsAppPreferencesPanel />
        <WhatsAppSettingsPanel />
        <IntegrationStatusPanel />

        {/* Notifikasi Telegram (personal) — dipindah dari Dashboard Penjual. */}
        <section className="dash-panel" style={{ marginBottom: 0 }}>
          <h2>Notifikasi Telegram</h2>
          {telegramError && (
            <div className="form-error-banner" role="alert">
              {telegramError}
            </div>
          )}
          {telegramSuccess && (
            <div className="form-success-banner" role="status">
              {telegramSuccess}
            </div>
          )}
          {profile?.telegramChatId ? (
            <>
              <div style={{ marginBottom: "1rem" }}>
                <strong>Status:</strong> Terhubung
                {profile.telegramLinkedAt && (
                  <span style={{ marginLeft: "0.5rem", color: "var(--text-muted)", fontSize: "0.875rem" }}>
                    Sejak {formatDateId(profile.telegramLinkedAt)}
                  </span>
                )}
              </div>
              <label
                className="dash-form-field"
                style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}
              >
                <input
                  type="checkbox"
                  checked={profile.telegramNotify}
                  onChange={onToggleTelegramNotify}
                  disabled={telegramLoading}
                />
                <span>Terima notifikasi via Telegram</span>
              </label>
              <button
                type="button"
                className="btn btn-outline"
                onClick={onUnlinkTelegram}
                disabled={telegramLoading}
                style={{ marginTop: "0.5rem" }}
              >
                {telegramLoading ? "Memproses…" : "Putuskan Hubungan Telegram"}
              </button>
            </>
          ) : (
            <>
              <p style={{ marginBottom: "1rem", color: "var(--text-muted)" }}>
                Hubungkan akun Telegram untuk menerima notifikasi pesanan, pembayaran, dan
                aktivitas penting secara real-time.
              </p>
              {linkToken ? (
                <div style={{ marginBottom: "1rem" }}>
                  <div style={{ marginBottom: "0.5rem" }}>
                    <strong>Token Linking:</strong>
                    <code
                      style={{
                        display: "block",
                        marginTop: "0.25rem",
                        padding: "0.5rem",
                        background: "var(--bg-code)",
                        borderRadius: "4px",
                        wordBreak: "break-all",
                        fontSize: "0.875rem",
                      }}
                    >
                      {linkToken}
                    </code>
                  </div>
                  <div style={{ fontSize: "0.875rem", color: "var(--text-muted)", marginBottom: "1rem" }}>
                    <strong>Berlaku sampai:</strong> {linkExpiresAt ? formatDateId(linkExpiresAt) : "—"}{" "}
                    &nbsp;|&nbsp; <strong>Bot:</strong> @{botUsername}
                  </div>
                  <ol style={{ paddingLeft: "1.25rem", fontSize: "0.875rem", lineHeight: "1.8" }}>
                    <li>
                      Buka Telegram dan cari <strong>@{botUsername}</strong>
                    </li>
                    <li>
                      Kirim perintah: <code>/start {linkToken}</code>
                    </li>
                    <li>Token berlaku 15 menit dan hanya bisa dipakai sekali.</li>
                  </ol>
                  <button
                    type="button"
                    className="btn btn-outline"
                    onClick={onGenerateTelegramLink}
                    disabled={telegramLoading}
                    style={{ marginTop: "1rem" }}
                  >
                    {telegramLoading ? "Memproses…" : "Buat Token Baru"}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onGenerateTelegramLink}
                  disabled={telegramLoading}
                >
                  {telegramLoading ? "Memproses…" : "Hubungkan Akun Telegram"}
                </button>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
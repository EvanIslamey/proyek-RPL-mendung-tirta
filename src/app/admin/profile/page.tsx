"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { formatDateId } from "@/lib/format";

type Profile = {
  id: string;
  name: string;
  email: string;
  role: string;
  address: string | null;
  orderCount: number;
  createdAt: string;
};

export default function AdminProfilePage() {
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

  const load = useCallback(() => {
    fetch("/api/profile", { cache: "no-store" })
      .then((res) => {
        if (res.status === 401) {
          router.push("/login?next=/admin/profile");
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
          <h1>Profil Admin</h1>
          <p>
            {profile
              ? `Administrator sejak ${formatDateId(profile.createdAt)}`
              : ""}
          </p>
        </div>
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
          <h2>Profil</h2>
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
                <span>Alamat</span>
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
            <dt>Total pesanan</dt>
            <dd>{profile?.orderCount ?? 0}</dd>
          </dl>
        </section>
      </div>
    </>
  );
}
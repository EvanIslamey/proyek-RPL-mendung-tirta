"use client";

/**
 * Panel Preferensi Notifikasi WhatsApp — halaman Informasi Diri (SEMUA role).
 *
 * Pengguna mengisi nomor WhatsApp profil (+62) dan mengaktifkan/menonaktifkan
 * persetujuan notifikasi WhatsApp milik sendiri (opt-in). Tidak ada rahasia di
 * panel ini; pengiriman hanya terjadi bila persetujuan aktif, nomor valid, dan
 * konfigurasi WhatsApp global admin sedang aktif — satu kejadian satu pesan.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useToast } from "@/components/ui/Toast";
import "./settings.css";

type ProfileSlice = { phone: string | null; whatsappNotify: boolean };

export function WhatsAppPreferencesPanel() {
  const { toast } = useToast();

  const [phone, setPhone] = useState("");
  const [notify, setNotify] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    fetch("/api/profile", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          setLoadError("Sesi berakhir. Silakan masuk kembali.");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { profile: ProfileSlice } = await res.json();
        setPhone(data.profile.phone ?? "");
        setNotify(Boolean(data.profile.whatsappNotify));
        setLoadError(null);
        setLoaded(true);
      })
      .catch(() => setLoadError("Gagal memuat preferensi notifikasi."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setFields({});
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phone.trim() || null, whatsappNotify: notify }),
      });
      const data: { message?: string; fields?: Record<string, string> } = await res
        .json()
        .catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setFields(data.fields);
        setSaveError(data.message ?? "Gagal menyimpan preferensi.");
        return;
      }
      toast("Preferensi notifikasi WhatsApp tersimpan.");
      load();
    } catch {
      setSaveError("Tidak dapat terhubung ke server.");
    } finally {
      setSaving(false);
    }
  }

  if (!loaded && loadError) {
    return (
      <section className="dash-panel" style={{ marginBottom: 0 }}>
        <h2>Notifikasi WhatsApp</h2>
        <div className="form-error-banner" role="alert">
          {loadError}
        </div>
      </section>
    );
  }

  return (
    <section className="dash-panel" style={{ marginBottom: 0 }}>
      <h2 style={{ margin: 0 }}>Notifikasi WhatsApp</h2>
      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
        Aktifkan untuk menerima notifikasi WhatsApp (pesanan, pembayaran, status) ke nomor Anda.
        Pengiriman hanya dilakukan bila Anda memberikan persetujuan di bawah — tanpa persetujuan,
        tidak ada pesan yang dikirim.
      </p>

      {loadError && (
        <div className="form-error-banner" role="alert">
          {loadError}
        </div>
      )}
      {saveError && (
        <div className="form-error-banner" role="alert">
          {saveError}
        </div>
      )}

      <form onSubmit={onSave}>
        <div className="dash-form-grid" style={{ gridTemplateColumns: "1fr" }}>
          <label className="dash-form-field">
            <span>Nomor WhatsApp Anda (format internasional +62)</span>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+6281234567890"
              maxLength={20}
              autoComplete="tel"
            />
            {fields.phone && <span className="field-error">{fields.phone}</span>}
          </label>

          <label
            className="dash-form-field"
            style={{ flexDirection: "row", alignItems: "center", gap: "0.6rem" }}
          >
            <input
              type="checkbox"
              checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              style={{ width: "1.05rem", height: "1.05rem" }}
            />
            <span style={{ margin: 0 }}>
              Aktifkan notifikasi WhatsApp ke nomor di atas (persetujuan saya)
            </span>
          </label>
          {fields.whatsappNotify && (
            <span className="field-error" style={{ marginTop: "-0.6rem" }}>
              {fields.whatsappNotify}
            </span>
          )}
        </div>

        <div style={{ marginTop: "1.1rem", display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Menyimpan…" : "Simpan Preferensi"}
          </button>
        </div>
      </form>

      <p
        style={{
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          marginTop: "0.75rem",
          lineHeight: 1.5,
        }}
      >
        Catatan: nomor divalidasi format Indonesia (+62). Satu kejadian hanya menghasilkan satu
        pesan (tanpa duplikat), dan riwayat status pengiriman tercatat di server. Menonaktifkan
        persetujuan atau menghapus nomor menghentikan pengiriman berikutnya.
      </p>
    </section>
  );
}

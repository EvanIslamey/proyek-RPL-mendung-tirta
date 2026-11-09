"use client";

/**
 * Panel Pengaturan WhatsApp (Fonnte) — halaman Pengaturan Integrasi (Admin)
 * & halaman Informasi Diri (Penjual, scope miliknya sendiri).
 *
 * - Admin mengelola konfigurasi WhatsApp GLOBAL aplikasi (+ penerima notifikasi
 *   operasional, prop `showOps`).
 * - Penjual mengelola konfigurasi WhatsApp MILIKNYA sendiri (scope userId).
 * - API Token Fonnte disimpan terenkripsi di server; frontend hanya menerima
 *   hint tersamarkan — TIDAK PERNAH ditampilkan kembali utuh.
 * - Uji koneksi (POST /device), kirim pesan uji (POST /send), dan
 *   aktifkan/nonaktifkan dijalankan lewat backend (bukan dari browser).
 * - Field Meta Cloud API lama (Phone Number ID / Access Token) sudah dihapus.
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useToast } from "@/components/ui/Toast";
import "./settings.css";

type TestResult = { ok: boolean; note: string };

type SafeConfig = {
  id: string;
  provider: string;
  providerLabel: string;
  endpoint: string | null;
  meta: Record<string, string> | null;
  hasCredential: boolean;
  credentialHint: string | null;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestNote: string | null;
};

const PROVIDERS = [{ id: "fonnte", label: "Fonnte WhatsApp Gateway" }];

function statusBadge(cfg: SafeConfig | null): { label: string; cls: string } {
  if (!cfg) return { label: "Belum dikonfigurasi", cls: "badge-muted" };
  if (!cfg.isActive) return { label: "Tersimpan (nonaktif)", cls: "badge-warn" };
  if (cfg.lastTestOk === true) return { label: "Aktif & teruji", cls: "badge-ok" };
  return { label: "Terkonfigurasi (belum teruji)", cls: "badge-warn" };
}

export function WhatsAppSettingsPanel({ showOps = false }: { showOps?: boolean }) {
  const { toast } = useToast();

  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [provider, setProvider] = useState("fonnte");
  const [endpoint, setEndpoint] = useState("");
  const [credential, setCredential] = useState(""); // hanya input token BARU
  const [senderNumber, setSenderNumber] = useState("");
  const [testTo, setTestTo] = useState(""); // nomor tujuan pengujian (ikut disimpan)
  const [opsTargets, setOpsTargets] = useState(""); // penerima notifikasi operasional (admin)

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [sending, setSending] = useState(false);
  const [toggling, setToggling] = useState(false);

  const applyConfig = useCallback(
    (cfg: SafeConfig | null) => {
      setConfig(cfg);
      if (cfg) {
        setProvider(cfg.provider);
        setEndpoint(cfg.endpoint ?? "");
        setSenderNumber(cfg.meta?.senderNumber ?? "");
        setTestTo(cfg.meta?.testTarget ?? "");
        setOpsTargets(cfg.meta?.opsTargets ?? "");
      }
    },
    [],
  );

  const load = useCallback(() => {
    fetch("/api/settings/whatsapp", { cache: "no-store" })
      .then(async (res) => {
        setLoadError(null);
        if (res.status === 401) {
          setLoadError("Sesi berakhir. Silakan masuk kembali.");
          return null;
        }
        if (res.status === 403) {
          setLoadError("Anda tidak memiliki akses ke pengaturan ini.");
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { config: SafeConfig | null } = await res.json();
        applyConfig(data.config);
        setLoaded(true);
      })
      .catch(() => setLoadError("Gagal memuat konfigurasi. Coba lagi."));
  }, [applyConfig]);

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
      const res = await fetch("/api/settings/whatsapp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          meta: {
            ...(testTo ? { testTarget: testTo } : {}),
            ...(senderNumber ? { senderNumber } : {}),
            ...(opsTargets ? { opsTargets } : {}),
          },
          endpoint: endpoint || undefined,
          credential: credential || undefined, // kosong = token lama dipertahankan
        }),
      });
      const data: { message?: string; fields?: Record<string, string>; config?: SafeConfig } =
        await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setFields(data.fields);
        setSaveError(data.message ?? "Gagal menyimpan konfigurasi.");
        return;
      }
      if (data.config) applyConfig(data.config);
      setCredential(""); // bersihkan token dari memori form
      setTestResult(null);
      toast("Konfigurasi WhatsApp tersimpan.");
    } catch {
      setSaveError("Tidak dapat terhubung ke server.");
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/whatsapp/test", { method: "POST" });
      const data: { result?: TestResult; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestResult({ ok: false, note: data.message ?? "Gagal menjalankan uji." });
        return;
      }
      if (data.result) {
        setTestResult(data.result);
        toast(data.result.note, data.result.ok ? "success" : "error");
        load(); // segarkan status perangkat (meta.device*) + badge + lastTest
      }
    } catch {
      setTestResult({ ok: false, note: "Tidak dapat terhubung ke server." });
    } finally {
      setTesting(false);
    }
  }

  async function onSendTest() {
    if (sending) return;
    setSending(true);
    try {
      const res = await fetch("/api/settings/whatsapp/test", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo }),
      });
      const data: { result?: TestResult; message?: string; fields?: Record<string, string> } =
        await res.json().catch(() => ({}));
      if (!res.ok) {
        const note = data.fields?.to ?? data.message ?? "Gagal mengirim pesan uji.";
        setTestResult({ ok: false, note });
        return;
      }
      if (data.result) {
        setTestResult(data.result);
        toast(data.result.note, data.result.ok ? "success" : "error");
        load();
      }
    } catch {
      setTestResult({ ok: false, note: "Tidak dapat terhubung ke server." });
    } finally {
      setSending(false);
    }
  }

  async function onToggle() {
    if (toggling || !config) return;
    setToggling(true);
    setSaveError(null);
    try {
      const next = !config.isActive;
      const res = await fetch("/api/settings/whatsapp/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: next }),
      });
      const data: { message?: string; config?: SafeConfig } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSaveError(data.message ?? "Gagal mengubah status konfigurasi.");
        return;
      }
      if (data.config) applyConfig(data.config);
      toast(data.message ?? (next ? "Konfigurasi diaktifkan." : "Konfigurasi dinonaktifkan."));
    } catch {
      setSaveError("Tidak dapat terhubung ke server.");
    } finally {
      setToggling(false);
    }
  }

  if (!loaded && loadError) {
    return (
      <section className="dash-panel" style={{ marginBottom: 0 }}>
        <h2>Pengaturan WhatsApp</h2>
        <div className="form-error-banner" role="alert">
          {loadError}
        </div>
      </section>
    );
  }

  const badge = statusBadge(config);
  const meta = config?.meta ?? null;
  const deviceStatus = meta?.deviceStatus ?? null;

  return (
    <section className="dash-panel" style={{ marginBottom: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <h2 style={{ margin: 0 }}>Pengaturan WhatsApp</h2>
        <span className={`status-badge ${badge.cls}`}>{badge.label}</span>
      </div>

      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
        Provider: <strong>Fonnte WhatsApp Gateway</strong>. API Token disimpan terenkripsi di server
        dan tidak pernah dikirim ke browser. Pengujian dijalankan lewat server, bukan browser.
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
            <span>Provider / metode integrasi *</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="dash-form-field">
            <span>API Token Fonnte {config?.hasCredential ? "(kosongkan untuk mempertahankan)" : "*"}</span>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="off"
              placeholder={config?.hasCredential ? "•••••••• (tersimpan)" : "Tempel token dari menu Device"}
              required={!config?.hasCredential}
            />
            {fields.credential && <span className="field-error">{fields.credential}</span>}
            {config?.hasCredential && (
              <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>
                Tersimpan: {config.credentialHint}
              </span>
            )}
          </label>

          <label className="dash-form-field">
            <span>Nomor WhatsApp pengirim / perangkat (opsional, format +62)</span>
            <input
              type="tel"
              value={senderNumber}
              onChange={(e) => setSenderNumber(e.target.value)}
              maxLength={20}
              placeholder="+6281234567890"
            />
            {fields.senderNumber && <span className="field-error">{fields.senderNumber}</span>}
            <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>
              Nomor resmi pengirim = nomor perangkat yang terhubung di Fonnte (lihat status koneksi
              di bawah setelah Uji Koneksi).
            </span>
          </label>

          <label className="dash-form-field">
            <span>Nomor WhatsApp tujuan pengujian (E.164, mis. +62812…)</span>
            <input
              type="tel"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="+6281234567890"
              maxLength={20}
            />
            {fields.testTarget && <span className="field-error">{fields.testTarget}</span>}
          </label>

          {showOps && (
            <label className="dash-form-field">
              <span>Penerima notifikasi operasional (admin)</span>
              <input
                type="tel"
                value={opsTargets}
                onChange={(e) => setOpsTargets(e.target.value)}
                placeholder="+6281234567890, +6289876543210"
                maxLength={200}
              />
              {fields.opsTargets && <span className="field-error">{fields.opsTargets}</span>}
              <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>
                Nomor (dipisah koma) yang menerima pesan WhatsApp operasional untuk akun ADMIN
                (pesanan baru, pembayaran, pengguna baru, aktivitas penting). Kosongkan untuk memakai
                nomor profil admin masing-masing.
              </span>
            </label>
          )}

          <label className="dash-form-field">
            <span>API endpoint / URL (opsional)</span>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              maxLength={500}
              placeholder="https://api.fonnte.com"
            />
            {fields.endpoint && <span className="field-error">{fields.endpoint}</span>}
          </label>
        </div>

        <div
          style={{
            marginTop: "1.1rem",
            display: "flex",
            gap: "0.6rem",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Menyimpan…" : "Simpan Konfigurasi"}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onTest}
            disabled={testing || !config}
          >
            {testing ? "Menguji…" : "Uji Koneksi"}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onSendTest}
            disabled={sending || !config?.isActive || !testTo}
            title={
              !config?.isActive
                ? "Aktifkan & uji koneksi dulu"
                : !testTo
                  ? "Isi nomor tujuan pengujian"
                  : undefined
            }
          >
            {sending ? "Mengirim…" : "Kirim Pesan Uji"}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onToggle}
            disabled={toggling || !config}
            title={!config?.lastTestOk ? "Jalankan uji koneksi dulu" : undefined}
          >
            {toggling ? "Memproses…" : config?.isActive ? "Nonaktifkan" : "Aktifkan"}
          </button>
        </div>
      </form>

      {testResult && (
        <div
          className={testResult.ok ? "form-success-banner" : "form-error-banner"}
          role="status"
          style={{ marginTop: "0.9rem" }}
        >
          {testResult.note}
        </div>
      )}

      {config && (
        <div
          style={{
            marginTop: "0.9rem",
            fontSize: "0.8rem",
            color: "var(--text-muted)",
          }}
        >
          <div>
            Status: <strong>{config.isActive ? "Aktif" : "Nonaktif"}</strong>
            {" · "}Provider: <strong>{config.providerLabel}</strong>
          </div>

          {/* Status koneksi perangkat Fonnte (hasil Uji Koneksi terakhir). */}
          <div>
            Status koneksi perangkat:{" "}
            {!deviceStatus ? (
              <strong>belum diketahui (jalankan Uji Koneksi)</strong>
            ) : deviceStatus === "connect" ? (
              <>
                <strong style={{ color: "var(--ok, #16a34a)" }}>Terhubung</strong> — {meta?.deviceNumber}
                {meta?.deviceName ? ` (${meta.deviceName})` : ""}
                {meta?.deviceQuota ? `, sisa kuota ${meta.deviceQuota}` : ""}
                {meta?.devicePackage ? `, paket ${meta.devicePackage}` : ""}
                {meta?.deviceExpired ? `, berlaku s/d ${meta.deviceExpired}` : ""}
              </>
            ) : (
              <>
                <strong style={{ color: "#dc2626" }}>Terputus ({deviceStatus})</strong>
                {meta?.deviceNumber ? ` — ${meta.deviceNumber}` : ""} — hubungkan perangkat di
                dashboard Fonnte.
              </>
            )}
          </div>

          {config.lastTestAt && (
            <div>
              Uji terakhir:{" "}
              {config.lastTestOk === true ? "berhasil" : config.lastTestOk === false ? "gagal" : "—"}{" "}
              ({new Date(config.lastTestAt).toLocaleString("id-ID")})
              {config.lastTestNote ? ` — ${config.lastTestNote}` : ""}
            </div>
          )}
        </div>
      )}

      <div
        style={{
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          marginTop: "0.75rem",
          lineHeight: 1.5,
        }}
      >
        <strong>Petunjuk Fonnte (WhatsApp Gateway):</strong>
        <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}>
          <li>
            <strong>Hubungkan perangkat:</strong> dashboard Fonnte → menu <strong>Device</strong> →{" "}
            <strong>Connect</strong> → buka WhatsApp di ponsel → Perangkat Tertaut → Tautkan
            perangkat → pindai QR. Pastikan status sudah “connect” sebelum menguji.
          </li>
          <li>
            <strong>API Token</strong> disalin dari menu Device (klik token untuk menyalin). Token
            disimpan terenkripsi di server, tidak pernah ditampilkan utuh, dan tidak perlu dikirim
            lewat chat. Kosongkan field saat menyimpan bila ingin mempertahankan token lama.
          </li>
          <li>
            <strong>Uji Koneksi</strong> membaca status perangkat nyata dari Fonnte (nomor, status
            connect/putus, sisa kuota, masa berlaku). <strong>Kirim Pesan Uji</strong> hanya
            mengirim ketika tombol ditekan dan konfigurasi sudah aktif.
          </li>
          <li>
            Nomor tujuan uji/notifikasi harus menyimpan nomor pengirim Anda (opt-in). Pengiriman
            bergantung status perangkat &amp; kuota paket Fonnte Anda.
          </li>
          <li>
            Notifikasi WhatsApp berjalan otomatis setelah konfigurasi GLOBAL aktif: penerima memakai
            nomor profil (+62) dengan persetujuan pengguna, atau nomor penerima operasional (admin).
          </li>
        </ul>
      </div>

      <p
        style={{
          fontSize: "0.75rem",
          color: "var(--text-muted)",
          marginTop: "0.75rem",
          lineHeight: 1.5,
        }}
      >
        <strong>Catatan webhook:</strong> integrasi ini hanya untuk pengiriman keluar (outbound).
        Webhook masuk Fonnte membutuhkan endpoint HTTPS publik — server lokal (localhost) tidak
        diekspos ke internet tanpa persetujuan Anda (tunnel/endpoint publik bila suatu saat
        diperlukan).
      </p>
    </section>
  );
}

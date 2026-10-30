"use client";

/**
 * Panel Pengaturan WhatsApp — untuk halaman Informasi Diri (Admin & Penjual).
 *
 * - Admin mengelola konfigurasi WhatsApp GLOBAL aplikasi.
 * - Penjual mengelola konfigurasi WhatsApp MILIKNYA sendiri (scope userId).
 * - Credential tidak pernah dikirim ke frontend (hanya hint tersamarkan).
 * - Uji koneksi & kirim pesan uji dijalankan lewat backend (bukan dari browser).
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

const PROVIDERS = [{ id: "meta-whatsapp-cloud", label: "Meta WhatsApp Cloud API" }];

function statusBadge(cfg: SafeConfig | null): { label: string; cls: string } {
  if (!cfg) return { label: "Belum dikonfigurasi", cls: "badge-muted" };
  if (!cfg.isActive) return { label: "Tersimpan (nonaktif)", cls: "badge-warn" };
  if (cfg.lastTestOk === true) return { label: "Terkonfigurasi & teruji", cls: "badge-ok" };
  return { label: "Terkonfigurasi (belum teruji)", cls: "badge-warn" };
}

export function WhatsAppSettingsPanel() {
  const { toast } = useToast();

  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [provider, setProvider] = useState("meta-whatsapp-cloud");
  const [phoneId, setPhoneId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credential, setCredential] = useState(""); // hanya untuk input baru

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [sending, setSending] = useState(false);
  const [testTo, setTestTo] = useState("");

  const applyConfig = useCallback((cfg: SafeConfig | null) => {
    setConfig(cfg);
    if (cfg) {
      setProvider(cfg.provider);
      setPhoneId(cfg.meta?.phoneId ?? "");
      setEndpoint(cfg.endpoint ?? "");
    }
  }, []);

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
          meta: { phoneId },
          endpoint: endpoint || undefined,
          credential: credential || undefined,
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
      setCredential(""); // bersihkan input credential dari memori form
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
        load(); // segarkan badge status + lastTest
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
        Konfigurasi ini disimpan aman di server (terenkripsi). Credential tidak pernah ditampilkan
        kembali utuh. Pengujian dijalankan lewat server, bukan browser.
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
            <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>
              Provider lain (WhatsApp Business API pihak ketiga) dapat ditambahkan sebagai adapter.
            </span>
          </label>

          <label className="dash-form-field">
            <span>Phone Number ID (WhatsApp Business) *</span>
            <input
              type="text"
              value={phoneId}
              onChange={(e) => setPhoneId(e.target.value)}
              maxLength={100}
              placeholder="ID nomor dari Meta Business Suite"
              required
            />
            {fields.phoneId && <span className="field-error">{fields.phoneId}</span>}
          </label>

          <label className="dash-form-field">
            <span>API endpoint / URL (opsional)</span>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              maxLength={500}
              placeholder="https://graph.facebook.com/v21.0"
            />
            {fields.endpoint && <span className="field-error">{fields.endpoint}</span>}
          </label>

          <label className="dash-form-field">
            <span>Access token {config?.hasCredential ? "(kosongkan untuk mempertahankan)" : "*"}</span>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="off"
              placeholder={config?.hasCredential ? "•••••••• (tersimpan)" : "Masukkan access token"}
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
            <span>Nomor WhatsApp tujuan (E.164, mis. +62812…) untuk pesan uji</span>
            <input
              type="tel"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="+6281234567890"
              maxLength={20}
            />
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
                  ? "Isi nomor tujuan"
                  : undefined
            }
          >
            {sending ? "Mengirim…" : "Kirim Pesan Uji"}
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
          </div>
          {config.lastTestAt && (
            <div>
              Uji terakhir:{" "}
              {config.lastTestOk === true ? "berhasil" : config.lastTestOk === false ? "gagal" : "—"}{" "}
              ({new Date(config.lastTestAt).toLocaleString("id-ID")})
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
        <strong>Petunjuk Meta (WhatsApp Cloud API):</strong>
        <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}>
          <li>
            <strong>Phone Number ID</strong> diambil dari Meta Developer Dashboard → App → WhatsApp →
            API Setup (berupa angka ID), bukan email admin atau nomor WhatsApp tujuan.
          </li>
          <li>
            <strong>Access token</strong> juga dari halaman yang sama (token uji sementara atau token
            permanen). Token disimpan terenkripsi di server dan tidak pernah ditampilkan kembali.
          </li>
          <li>
            Pesan uji memakai format teks biasa. Di luar jendela 24 jam sejak pelanggan menghubungi
            Anda, Meta hanya mengizinkan pesan yang memakai <strong>template disetujui</strong> —
            bila pengiriman ditolak provider, buat template di Meta Manager atau mulai percakapan
            dari nomor tujuan lebih dulu.
          </li>
          <li>
            Nomor tujuan harus bersedia menerima pesan (opt-in) dari nomor WhatsApp Business Anda.
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
        <strong>Catatan webhook:</strong> server lokal (localhost) tidak dapat menerima webhook dari
        internet tanpa tunnel (mis. ngrok) atau endpoint publik. Fitur ini hanya untuk pengiriman
        keluar (outbound). Jangan mengekspos server lokal secara otomatis.
      </p>
    </section>
  );
}

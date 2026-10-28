"use client";

/**
 * Panel Pengaturan API Key AI — untuk halaman Informasi Diri (hanya Admin).
 *
 * - Menyimpan API Key provider AI chatbot (OpenAI-compatible / NVIDIA NIM / ds.).
 * - Nilai API key TIDAK PERNAH dikirim utuh ke frontend (hanya hint tersamarkan).
 * - Menyimpan, menguji koneksi, mengaktifkan/menonaktifkan, dan menghapus.
 * - Konfigurasi aktif dipakai chatbot backend (src/lib/ai.ts → resolveAiRuntime).
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
  model: string | null;
  meta: Record<string, string> | null;
  hasCredential: boolean;
  credentialHint: string | null;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestNote: string | null;
};

const PROVIDERS = [
  { id: "openai-compatible", label: "OpenAI-compatible (OpenAI / NVIDIA NIM / ds.)" },
];

function statusBadge(cfg: SafeConfig | null): { label: string; cls: string } {
  if (!cfg) return { label: "Belum dikonfigurasi", cls: "badge-muted" };
  if (!cfg.isActive) return { label: "Tersimpan (nonaktif)", cls: "badge-warn" };
  if (cfg.lastTestOk === true) return { label: "Aktif & teruji", cls: "badge-ok" };
  return { label: "Aktif (belum teruji ulang)", cls: "badge-warn" };
}

export function ApiKeySettingsPanel() {
  const { toast } = useToast();

  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [provider, setProvider] = useState("openai-compatible");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [credential, setCredential] = useState(""); // hanya input baru

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const applyConfig = useCallback((cfg: SafeConfig | null) => {
    setConfig(cfg);
    if (cfg) {
      setName(cfg.meta?.name ?? "");
      setProvider(cfg.provider);
      setEndpoint(cfg.endpoint ?? "");
      setModel(cfg.model ?? "");
    }
  }, []);

  const load = useCallback(() => {
    fetch("/api/settings/api-key", { cache: "no-store" })
      .then(async (res) => {
        setLoadError(null);
        if (res.status === 401) {
          setLoadError("Sesi berakhir. Silakan masuk kembali.");
          return null;
        }
        if (res.status === 403) {
          setLoadError("Hanya admin yang dapat mengelola API Key layanan aplikasi.");
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
      const res = await fetch("/api/settings/api-key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          provider,
          endpoint: endpoint || undefined,
          model: model || undefined,
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
      setCredential("");
      setTestResult(null);
      toast("Konfigurasi API Key tersimpan.");
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
      const res = await fetch("/api/settings/api-key/test", { method: "POST" });
      const data: { result?: TestResult; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestResult({ ok: false, note: data.message ?? "Gagal menjalankan uji." });
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
      setTesting(false);
    }
  }

  async function onToggle() {
    if (toggling || !config) return;
    setToggling(true);
    try {
      const res = await fetch("/api/settings/api-key/toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !config.isActive }),
      });
      const data: { message?: string; config?: SafeConfig } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal mengubah status.", "error");
        return;
      }
      if (data.config) applyConfig(data.config);
      toast(data.message ?? "Status diperbarui.");
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
    } finally {
      setToggling(false);
    }
  }

  async function onDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/settings/api-key", { method: "DELETE" });
      const data: { message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.message ?? "Gagal menghapus konfigurasi.", "error");
        return;
      }
      applyConfig(null);
      setCredential("");
      setTestResult(null);
      toast(data.message ?? "Konfigurasi dihapus.");
    } catch {
      toast("Tidak dapat terhubung ke server.", "error");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (!loaded && loadError) {
    return (
      <section className="dash-panel" style={{ marginBottom: 0 }}>
        <h2>Pengaturan API Key</h2>
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
        <h2 style={{ margin: 0 }}>Pengaturan API Key</h2>
        <span className={`status-badge ${badge.cls}`}>{badge.label}</span>
      </div>

      <p className="integration-hint">
        API Key disimpan terenkripsi di server dan tidak pernah dikirim ke browser. Nilai lama tidak
        pernah ditampilkan. Konfigurasi aktif dipakai chatbot untuk menjawab.
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
            <span>Nama konfigurasi *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              placeholder="mis. Chatbot Utama"
              required
            />
          </label>

          <label className="dash-form-field">
            <span>Jenis layanan / provider *</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="dash-form-field">
            <span>API Key {config?.hasCredential ? "(kosongkan untuk mempertahankan)" : "*"}</span>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="off"
              placeholder={config?.hasCredential ? "•••••••• (tersimpan)" : "Masukkan API key"}
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
            <span>Base URL (opsional — jika provider mendukung)</span>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              maxLength={500}
              placeholder="https://api.openai.com/v1"
            />
            {fields.endpoint && <span className="field-error">{fields.endpoint}</span>}
          </label>

          <label className="dash-form-field">
            <span>Model (opsional — untuk layanan AI)</span>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              maxLength={120}
              placeholder="mis. gpt-4o-mini"
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
            {saving ? "Menyimpan…" : "Simpan"}
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
            onClick={onToggle}
            disabled={toggling || !config}
          >
            {toggling
              ? "Memproses…"
              : config?.isActive
                ? "Nonaktifkan"
                : "Aktifkan"}
          </button>
          <button
            type="button"
            className="btn btn-outline"
            onClick={onDelete}
            disabled={deleting || !config}
            style={confirmDelete ? { borderColor: "#dc2626", color: "#dc2626" } : undefined}
          >
            {deleting
              ? "Menghapus…"
              : confirmDelete
                ? "Yakin hapus? (klik lagi)"
                : "Hapus"}
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
        <div style={{ marginTop: "0.9rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
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

      <p className="integration-hint" style={{ marginTop: "0.75rem" }}>
        Jika dihapus atau dinonaktifkan, chatbot kembali memakai API key environment variable
        (AI_API_KEY) bila ada; jika tidak ada, chatbot menjawab mode fallback berbasis data.
      </p>
    </section>
  );
}

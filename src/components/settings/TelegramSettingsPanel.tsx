"use client";

/**
 * Panel Pengaturan Telegram — halaman Informasi Diri (khusus Administrator).
 *
 * - Konfigurasi Telegram GLOBAL aplikasi (scope ""), independen dari
 *   WhatsApp/Fonnte: menonaktifkan salah satu TIDAK memengaruhi lainnya.
 * - Bot Token disimpan terenkripsi di server; frontend hanya menerima hint
 *   tersamarkan — TIDAK PERNAH ditampilkan kembali utuh.
 * - Uji koneksi (getMe), kirim pesan uji (sendMessage), dan
 *   aktifkan/nonaktifkan dijalankan lewat backend (bukan dari browser).
 * - Menyimpan konfigurasi tidak pernah mengirim pesan otomatis.
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

function statusBadge(cfg: SafeConfig | null): { label: string; cls: string } {
  if (!cfg) return { label: "Belum dikonfigurasi", cls: "badge-muted" };
  if (!cfg.isActive) return { label: "Tersimpan (nonaktif)", cls: "badge-warn" };
  if (cfg.lastTestOk === true) return { label: "Aktif & teruji", cls: "badge-ok" };
  return { label: "Terkonfigurasi (belum teruji)", cls: "badge-warn" };
}

export function TelegramSettingsPanel() {
  const { toast } = useToast();

  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [credential, setCredential] = useState(""); // hanya input token BARU
  const [chatId, setChatId] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [sending, setSending] = useState(false);
  const [toggling, setToggling] = useState(false);

  const applyConfig = useCallback((cfg: SafeConfig | null) => {
    setConfig(cfg);
    setChatId(cfg?.meta?.chatId ?? "");
  }, []);

  const load = useCallback(() => {
    fetch("/api/settings/telegram", { cache: "no-store" })
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
      const res = await fetch("/api/settings/telegram", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meta: { chatId },
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
      toast("Konfigurasi Telegram tersimpan.");
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
      const res = await fetch("/api/settings/telegram/test", { method: "POST" });
      const data: { result?: TestResult; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestResult({ ok: false, note: data.message ?? "Gagal menjalankan uji." });
        return;
      }
      if (data.result) {
        setTestResult(data.result);
        toast(data.result.note, data.result.ok ? "success" : "error");
        load(); // segarkan badge + botUsername + lastTest
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
      const res = await fetch("/api/settings/telegram/test", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data: { result?: TestResult; message?: string } = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTestResult({ ok: false, note: data.message ?? "Gagal mengirim pesan uji." });
        return;
      }
      if (data.result) {
        setTestResult(data.result);
        toast(data.result.note, data.result.ok ? "success" : "error");
        load(); // segarkan lastSentAt
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
      const res = await fetch("/api/settings/telegram/toggle", {
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
        <h2>Pengaturan Telegram</h2>
        <div className="form-error-banner" role="alert">
          {loadError}
        </div>
      </section>
    );
  }

  const badge = statusBadge(config);
  const meta = config?.meta ?? null;
  const botUsername = meta?.botUsername ?? null;
  const lastSentAt = meta?.lastSentAt ?? null;

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
        <h2 style={{ margin: 0 }}>Pengaturan Telegram</h2>
        <span className={`status-badge ${badge.cls}`}>{badge.label}</span>
      </div>

      <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.35rem" }}>
        Provider: <strong>Telegram Bot API</strong>. Bot Token disimpan terenkripsi di server dan
        tidak pernah dikirim ke browser. Independen dari WhatsApp/Fonnte — menonaktifkan salah satu
        tidak memengaruhi yang lain.
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
            <span>Bot Token {config?.hasCredential ? "(kosongkan untuk mempertahankan)" : "*"}</span>
            <input
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="off"
              placeholder={config?.hasCredential ? "•••••••• (tersimpan)" : "Tempel token dari BotFather"}
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
            <span>Chat ID tujuan notifikasi &amp; pesan uji</span>
            <input
              type="text"
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              maxLength={30}
              placeholder="123456789 atau -1001234567890"
            />
            {fields.chatId && <span className="field-error">{fields.chatId}</span>}
            <span style={{ fontSize: "0.75rem", fontWeight: 400 }}>
              Angka positif untuk chat pribadi, negatif untuk grup/channel. Dapatkan dari bot
              @userinfobot atau @getmyid_bot. Kosongkan untuk menghapus.
            </span>
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
            disabled={sending || !config?.isActive || !chatId.trim()}
            title={
              !config?.isActive
                ? "Aktifkan & uji koneksi dulu"
                : !chatId.trim()
                  ? "Isi Chat ID dulu"
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
          <div>
            Bot:{" "}
            {botUsername ? (
              <strong>@{botUsername}</strong>
            ) : (
              <strong>belum diketahui (jalankan Uji Koneksi)</strong>
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
          <div>
            Pesan uji terakhir dikirim:{" "}
            {lastSentAt ? (
              <strong>{new Date(lastSentAt).toLocaleString("id-ID")}</strong>
            ) : (
              "belum pernah"
            )}
          </div>
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
        <strong>Petunjuk Telegram:</strong>
        <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1.1rem" }}>
          <li>
            <strong>Buat bot:</strong> chat @BotFather di Telegram → <strong>/newbot</strong> →
            ikuti instruksinya → salin <strong>Bot Token</strong> (format 123456789:AA…).
          </li>
          <li>
            <strong>Dapatkan Chat ID:</strong> forward pesan dari Anda ke @userinfobot (chat
            pribadi) atau tambahkan bot ke grup lalu lihat ID-nya (grup/channel berawalan -100…).
          </li>
          <li>
            Token disimpan terenkripsi di server, tidak pernah ditampilkan utuh, dan tidak perlu
            dikirim lewat chat. Kosongkan field saat menyimpan bila ingin mempertahankan token lama.
          </li>
          <li>
            <strong>Uji Koneksi</strong> memverifikasi bot nyata via getMe; <strong>Kirim Pesan
            Uji</strong> hanya mengirim ketika tombol ditekan dan konfigurasi sudah aktif.
            Menyimpan konfigurasi tidak pernah mengirim pesan otomatis.
          </li>
          <li>
            Notifikasi Telegram (pesanan baru, pembayaran berhasil, aktivitas penting) berjalan
            otomatis setelah konfigurasi aktif dan akun pengguna menautkan Telegram dengan
            preferensi notifikasi aktif.
          </li>
        </ul>
      </div>
    </section>
  );
}

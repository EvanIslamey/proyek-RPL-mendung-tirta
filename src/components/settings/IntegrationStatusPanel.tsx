"use client";

/**
 * Panel "Status Koneksi & Riwayat Pengujian" — ringkasan konfigurasi
 * (WhatsApp & API Key AI): halaman Pengaturan Integrasi (Admin) dan
 * Informasi Diri (Penjual).
 *
 * Untuk penjual, endpoint API Key akan menolak (403) dan barisnya disembunyikan.
 * Nilai rahasia tidak pernah ditampilkan — hanya status & waktu uji.
 */

import { useCallback, useEffect, useState } from "react";
import "./settings.css";

type SafeConfig = {
  id: string;
  service: "WHATSAPP" | "AI_PROVIDER";
  providerLabel: string;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestNote: string | null;
};

type Row = { key: string; label: string; config: SafeConfig | null; hidden?: boolean };

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("id-ID");
  } catch {
    return "—";
  }
}

function testLabel(ok: boolean | null): string {
  if (ok === true) return "Berhasil";
  if (ok === false) return "Gagal";
  return "Belum pernah";
}

export function IntegrationStatusPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/settings/whatsapp", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { config: null }))
        .catch(() => ({ config: null })),
      fetch("/api/settings/api-key", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : { config: null, forbidden: r.status === 403 }))
        .catch(() => ({ config: null })),
    ]).then(([wa, ai]) => {
      const out: Row[] = [
        { key: "wa", label: "WhatsApp", config: (wa as { config: SafeConfig | null }).config },
        {
          key: "ai",
          label: "API Key AI (Chatbot)",
          config: (ai as { config: SafeConfig | null }).config,
          hidden: (ai as { forbidden?: boolean }).forbidden === true,
        },
      ];
      setRows(out);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = rows.filter((r) => !r.hidden);

  return (
    <section className="dash-panel" style={{ marginBottom: 0 }}>
      <h2 style={{ marginTop: 0 }}>Status Koneksi &amp; Riwayat Pengujian</h2>
      {!loaded ? (
        <div className="dash-loading" aria-busy="true">
          Memuat status…
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.82rem",
              minWidth: "320px",
            }}
          >
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #e5e7eb)" }}>
                <th style={{ padding: "0.4rem 0.5rem 0.4rem 0" }}>Layanan</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Provider</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Status</th>
                <th style={{ padding: "0.4rem 0.5rem" }}>Uji terakhir</th>
                <th style={{ padding: "0.4rem 0 0.4rem 0.5rem" }}>Hasil uji</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.key} style={{ borderBottom: "1px solid var(--border, #f3f4f6)" }}>
                  <td style={{ padding: "0.5rem 0.5rem 0.5rem 0", fontWeight: 600 }}>{r.label}</td>
                  <td style={{ padding: "0.5rem" }}>
                    {r.config ? r.config.providerLabel : <span style={{ color: "var(--text-muted)" }}>—</span>}
                  </td>
                  <td style={{ padding: "0.5rem" }}>
                    {!r.config ? (
                      <span className="status-badge badge-muted">Belum dikonfigurasi</span>
                    ) : r.config.isActive ? (
                      <span className="status-badge badge-ok">Aktif</span>
                    ) : (
                      <span className="status-badge badge-warn">Nonaktif</span>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem" }}>{r.config ? fmtTime(r.config.lastTestAt) : "—"}</td>
                  <td style={{ padding: "0.5rem" }}>
                    <span
                      className={
                        r.config?.lastTestOk === true
                          ? "status-badge badge-ok"
                          : r.config?.lastTestOk === false
                            ? "status-badge badge-warn"
                            : "status-badge badge-muted"
                      }
                    >
                      {testLabel(r.config?.lastTestOk ?? null)}
                    </span>
                    {r.config?.lastTestNote && (
                      <div
                        style={{
                          color: "var(--text-muted)",
                          fontSize: "0.72rem",
                          marginTop: "0.2rem",
                          maxWidth: "260px",
                        }}
                      >
                        {r.config.lastTestNote}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="integration-hint" style={{ marginTop: "0.75rem" }}>
        Hasil uji berasal dari permintaan nyata ke provider yang dikirim server. Kegagalan provider
        ditampilkan apa adanya. Webhook dari internet tidak dapat diterima di localhost tanpa tunnel.
      </p>
    </section>
  );
}

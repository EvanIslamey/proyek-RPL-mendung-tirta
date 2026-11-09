import { WhatsAppSettingsPanel } from "@/components/settings/WhatsAppSettingsPanel";
import { TelegramSettingsPanel } from "@/components/settings/TelegramSettingsPanel";
import { ApiKeySettingsPanel } from "@/components/settings/ApiKeySettingsPanel";
import { IntegrationStatusPanel } from "@/components/settings/IntegrationStatusPanel";

/**
 * Halaman PENGATURAN INTEGRASI (khusus ADMIN) — /admin/integrations.
 *
 * Dipisah dari Informasi Diri: seluruh konfigurasi API eksternal (WhatsApp
 * Fonnte, Telegram, API Key AI) beserta status & riwayat pengujian berada di
 * sini. Informasi Diri kini hanya pengelolaan akun pribadi.
 *
 * - Guard peran: AdminLayout (server) menolak selain ADMIN; endpoint backend
 *   tetap memverifikasi sesi + scope global sendiri (tanpa perubahan).
 * - WhatsApp, Telegram, dan AI berjalan independen — menonaktifkan satu tidak
 *   memengaruhi lainnya; tidak ada perubahan pada sistem event notifikasi.
 * - Kredensial TIDAK PERNAH dikirim ke frontend (hanya hint tersamarkan).
 */
export default function AdminIntegrationsPage() {
  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Pengaturan Integrasi</h1>
          <p>
            Kelola kanal notifikasi & layanan eksternal aplikasi. WhatsApp (Fonnte),
            Telegram, dan API Key AI berjalan independen — menonaktifkan satu tidak
            memengaruhi yang lain.
          </p>
        </div>
      </div>

      {/* Dua bagian utama: WhatsApp & Telegram — kartu terpisah, kontrol masing-masing.
          min(100%, …) agar kolom tidak pernah melebihi viewport (anti-overflow 360px). */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
          gap: "1.5rem",
          alignItems: "start",
        }}
      >
        <WhatsAppSettingsPanel showOps />
        <TelegramSettingsPanel />
      </div>

      {/* API Key AI + ringkasan status/riwayat pengujian kedua kanal. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
          gap: "1.5rem",
          alignItems: "start",
          marginTop: "1.5rem",
        }}
      >
        <ApiKeySettingsPanel />
        <IntegrationStatusPanel />
      </div>
    </>
  );
}

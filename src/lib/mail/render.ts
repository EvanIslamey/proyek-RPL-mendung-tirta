/**
 * Template email notifikasi Mendung Tirta — HTML responsif, inline styles
 * (ramah client email), semua konten dinamisescape (anti HTML injection).
 *
 * Konten yang masuk berasal dari data user/produk (user-generated) → wajib
 * lewat escapeHtml. Tautan disusun dari ID server (uuid), tetap di-escape.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const APP_NAME = "Mendung Tirta";

/** Navigasi tanggal Indonesia yang stabil (tanpa ICU pun aman). */
export function formatDateId(d: Date): string {
  return d.toLocaleString("id-ID", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type EmailContent = {
  /** Judul notifikasi (sudah berbahasa Indonesia dari pemanggil). */
  title: string;
  /** Paragraf/ringkasan per baris — SEMUA di-escape. */
  lines: string[];
  /** Tautan aksi opsional (halaman terkait). */
  link?: { href: string; label: string } | null;
  /** Waktu kejadian. */
  timestamp?: Date;
};

function absoluteUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  if (/^https?:\/\//i.test(path)) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Render konten notifikasi jadi { html, text } dalam layout merek.
 * Layout: tabel 600px (standar email), header teal, tombol CTA, footer bantuan.
 */
export function renderEmail(toName: string | undefined, content: EmailContent): {
  html: string;
  text: string;
} {
  const greeting = toName ? `Halo, ${escapeHtml(toName)}.` : "Halo.";
  const linesHtml = content.lines
    .map((l) => `<p style="margin:0 0 10px;color:#334155;font-size:14px;line-height:1.6;">${escapeHtml(l)}</p>`)
    .join("");
  const cta = content.link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td style="border-radius:6px;background:#0f766e;">
        <a href="${escapeHtml(absoluteUrl(content.link.href))}" style="display:inline-block;padding:12px 22px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">${escapeHtml(content.link.label)}</a>
      </td></tr></table>`
    : "";
  const stamp = content.timestamp
    ? `<p style="margin:0 0 4px;color:#94a3b8;font-size:12px;">Waktu: ${escapeHtml(formatDateId(content.timestamp))}</p>`
    : "";

  const html = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(content.title)}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e2e8f0;">
    <tr><td style="background:#0f766e;padding:18px 24px;">
      <span style="color:#ffffff;font-size:18px;font-weight:bold;">${APP_NAME}</span>
      <span style="color:#ccfbf1;font-size:12px;display:block;margin-top:2px;">Marketplace hasil laut &amp; alat pancing lokal</span>
    </td></tr>
    <tr><td style="padding:24px;">
      <p style="margin:0 0 6px;color:#0f172a;font-size:15px;">${greeting}</p>
      <h1 style="margin:0 0 14px;color:#0f172a;font-size:20px;line-height:1.4;">${escapeHtml(content.title)}</h1>
      ${linesHtml}
      ${cta}
      ${stamp}
    </td></tr>
    <tr><td style="background:#f8fafc;padding:16px 24px;border-top:1px solid #e2e8f0;">
      <p style="margin:0;color:#64748b;font-size:12px;line-height:1.6;">
        Email ini dikirim otomatis oleh sistem ${APP_NAME} — mohon jangan balas ke alamat ini.<br>
        Butuh bantuan? Buka <a href="${escapeHtml(absoluteUrl("/"))}" style="color:#0f766e;">situs ${APP_NAME}</a> atau hubungi layanan pelanggan.
      </p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const textParts = [
    toName ? `Halo, ${toName}.` : "Halo.",
    "",
    content.title,
    ...content.lines,
    content.link ? `${content.link.label}: ${absoluteUrl(content.link.href)}` : "",
    content.timestamp ? `Waktu: ${formatDateId(content.timestamp)}` : "",
    "",
    `— Email otomatis ${APP_NAME}. Jangan balas ke alamat ini.`,
  ].filter(Boolean);

  return { html, text: textParts.join("\n") };
}

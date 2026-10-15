/** Tipe bersama lapisan email. */

export type MailMessage = {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
};

export type Mailer = {
  /** Nama transport (outbox | smtp | http) — untuk log/dokumentasi. */
  readonly name: string;
  /** Kirim email; melempar bila transport gagal (tanggung jawab pemanggil). */
  send(message: MailMessage): Promise<void>;
};

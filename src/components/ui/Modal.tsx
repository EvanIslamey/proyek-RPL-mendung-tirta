"use client";

import { useEffect, type ReactNode } from "react";
import "./ui.css";

/**
 * Modal sederhana (client-only). Menutup dengan Esc / klik overlay.
 * Dipakai untuk form & dialog konfirmasi aksi destruktif.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-box" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="modal-close" aria-label="Tutup" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Dialog konfirmasi untuk aksi destruktif (hapus, batalkan, moderasi). */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = "Ya, lanjutkan",
  danger = true,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} title={title} onClose={busy ? () => undefined : onCancel}>
      <div className="modal-body">
        <p>{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn modal-cancel" onClick={onCancel} disabled={busy}>
            Batal
          </button>
          <button
            type="button"
            className={`btn ${danger ? "modal-danger" : "btn-primary"}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Memproses…" : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

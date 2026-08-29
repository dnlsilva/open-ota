import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

/**
 * Native <dialog>: focus trap, Escape and inertness come from the platform,
 * so there is no focus-management code to get wrong here.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? " wide" : ""}`}
      onClose={onClose}
      aria-labelledby="modal-title"
      onClick={(event) => {
        if (event.target === ref.current) ref.current?.close();
      }}
    >
      <div className="modal-head">
        <h2 id="modal-title">{title}</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>
      <div className="modal-body">{children}</div>
      {footer ? <div className="modal-foot">{footer}</div> : null}
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  confirmLabel,
  busy,
  danger = true,
  children,
  onClose,
  onConfirm,
}: {
  title: string;
  confirmLabel: string;
  busy?: boolean;
  danger?: boolean;
  children: ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
